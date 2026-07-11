require('dotenv').config();
const { Telegraf, session } = require('telegraf');
const { exec, spawn } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const execAsync = util.promisify(exec);
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

const OWNER_ID = Number.parseInt(process.env.OWNER_ID, 10);
const DATA_DIR = path.join(__dirname, 'pappy-data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const SUDO_FILE = path.join(DATA_DIR, 'sudo.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LEGACY_SUDO_FILE = path.join(__dirname, 'sudo.json');
const LEGACY_SETTINGS_FILE = path.join(__dirname, 'settings.json');
const MAX_OUTPUT = 3600;
const DASHBOARD_REFRESH_MS = 30 * 1000;
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.COMMAND_TIMEOUT_MS || '20000', 10);
const UPLOAD_TIMEOUT_MS = Number.parseInt(process.env.UPLOAD_TIMEOUT_MS || '120000', 10);
const ACTIVE_PROCESSES = new Map();

fs.mkdirSync(USERS_DIR, { recursive: true });

const loadJson = (file, fallback) => {
    try {
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
    } catch {
        return fallback;
    }
};

const persistJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

let sudoUsers = loadJson(SUDO_FILE, loadJson(LEGACY_SUDO_FILE, []));
const saveSudo = () => persistJson(SUDO_FILE, sudoUsers);

let appSettings = loadJson(SETTINGS_FILE, loadJson(LEGACY_SETTINGS_FILE, {
    codespaceName: process.env.CODESPACE_NAME || '',
    panelName: 'PAPPY OS',
    hostedSlotLimit: 1,
    storageQuotaMb: Number.parseInt(process.env.STORAGE_QUOTA_MB || '512', 10),
    cpuQuota: process.env.CPU_QUOTA || 'shared',
    ramQuotaMb: Number.parseInt(process.env.RAM_QUOTA_MB || '512', 10)
}));
const saveSettings = () => persistJson(SETTINGS_FILE, appSettings);

process.on('uncaughtException', (err) => console.error('🔥 Caught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled Rejection:', reason));

const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const clean = (value = '') => String(value).replace(ansiRegex, '').trim();
const clip = (value = '', size = MAX_OUTPUT) => clean(value).slice(-size) || 'No output.';
const escapeMd = (value = '') => String(value).replace(/([_\-*`[\]()~>#+=|{}.!])/g, '\\$1');
const shellQuote = (value = '') => `'${String(value).replace(/'/g, `'\\''`)}'`;
const slug = (value = 'project') => clean(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const shortId = () => crypto.randomBytes(4).toString('hex');
const activeKey = (id, deploymentId) => `${id}:${deploymentId}`;

const userId = (ctx) => String(ctx.from?.id || 'anonymous');
const userRoot = (id) => path.join(USERS_DIR, String(id));
const userFile = (id) => path.join(userRoot(id), 'profile.json');
const workspaceRoot = (id) => path.join(userRoot(id), 'workspace');
const uploadsRoot = (id) => path.join(userRoot(id), 'uploads');
const logsRoot = (id) => path.join(userRoot(id), 'logs');

function ensureUser(id, from = {}) {
    fs.mkdirSync(workspaceRoot(id), { recursive: true });
    fs.mkdirSync(uploadsRoot(id), { recursive: true });
    fs.mkdirSync(logsRoot(id), { recursive: true });
    const defaults = {
        id: String(id),
        username: from.username || '',
        createdAt: new Date().toISOString(),
        deployments: [],
        servers: [],
        github: { connected: false, repos: [], codespaces: [] },
        activity: [],
        terminalHistory: [],
        env: {},
        quota: {
            storageMb: id === String(OWNER_ID) ? 'unlimited' : appSettings.storageQuotaMb,
            ramMb: id === String(OWNER_ID) ? 'unlimited' : appSettings.ramQuotaMb,
            cpu: id === String(OWNER_ID) ? 'unlimited' : appSettings.cpuQuota,
            hostedSlots: id === String(OWNER_ID) ? 'unlimited' : appSettings.hostedSlotLimit
        }
    };
    const current = loadJson(userFile(id), defaults);
    const merged = { ...defaults, ...current, quota: { ...defaults.quota, ...(current.quota || {}) } };
    persistJson(userFile(id), merged);
    return merged;
}

function saveUser(profile) {
    persistJson(userFile(profile.id), profile);
}

function addActivity(id, text) {
    const profile = ensureUser(id);
    profile.activity = [{ at: new Date().toISOString(), text }, ...(profile.activity || [])].slice(0, 10);
    saveUser(profile);
}

function safeJoin(root, target = '.') {
    const resolved = path.resolve(root, target);
    const base = path.resolve(root);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error('Path escapes isolated workspace');
    return resolved;
}

async function safeEdit(ctx, text, options = {}) {
    try {
        if (ctx.callbackQuery?.message) return await ctx.editMessageText(text, options);
        return await ctx.reply(text, options);
    } catch (error) {
        console.error('safeEdit fallback:', error.message);
        try {
            return await ctx.reply(text, options);
        } catch (replyError) {
            console.error('safeEdit reply failed:', replyError.message);
            return null;
        }
    }
}

function runSafely(label, handler) {
    return async (ctx, next) => {
        try {
            return await handler(ctx, next);
        } catch (error) {
            console.error(`[${label}]`, error);
            const message = '⚠️ This panel module recovered from an error. Your session and other users are still running.';
            try {
                if (ctx.callbackQuery) await ctx.answerCbQuery('Module recovered from an error.', { show_alert: true }).catch(() => {});
                return await safeEdit(ctx, message, { ...mainMenu() });
            } catch (notifyError) {
                console.error(`[${label}] failed to notify user:`, notifyError);
                return null;
            }
        }
    };
}

function validateTerminalCommand(command) {
    const blocked = [
        /\brm\s+-rf\s+\/(?:\s|$)/i,
        /\bsudo\b/i,
        /\bsu\s/i,
        /:\(\)\s*\{\s*:\|:\s*&\s*\};:/,
        /\bmkfs\b/i,
        /\bdd\s+.*\bof=\/dev\//i,
        />\s*\/etc\//i,
        /\bchmod\s+-R\s+777\s+\//i
    ];
    return !blocked.some((pattern) => pattern.test(command));
}

async function dirSizeBytes(dir) {
    try {
        const { stdout } = await execAsync(`du -sb ${shellQuote(dir)} | cut -f1`, { timeout: 5000 });
        return Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
        return 0;
    }
}

async function systemStats(id) {
    const storageBytes = await dirSizeBytes(userRoot(id));
    const load = os.loadavg()[0];
    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();
    return {
        cpu: `${Math.min(100, Math.round((load / Math.max(os.cpus().length, 1)) * 100))}%`,
        ram: `${Math.round(usedMem / 1024 / 1024)} MB / ${Math.round(totalMem / 1024 / 1024)} MB`,
        storage: `${(storageBytes / 1024 / 1024).toFixed(1)} MB`,
        network: 'live via provider',
        uptime: `${Math.floor(process.uptime() / 60)}m`
    };
}

const keyboard = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const backHome = { text: '⬅️ Dashboard', callback_data: 'action_home' };

function pathToken(ctx, rel) {
    ctx.session.pathTokens = ctx.session.pathTokens || {};
    const token = shortId();
    ctx.session.pathTokens[token] = rel;
    const keys = Object.keys(ctx.session.pathTokens);
    if (keys.length > 50) delete ctx.session.pathTokens[keys[0]];
    return token;
}

function tokenPath(ctx, token) {
    return ctx.session.pathTokens?.[token] || '.';
}

async function dashboardText(ctx) {
    const id = userId(ctx);
    const profile = ensureUser(id, ctx.from || {});
    const stats = await systemStats(id);
    const active = (profile.deployments || []).filter((d) => d.status === 'running').length;
    const recent = (profile.activity || []).slice(0, 4).map((a) => `• ${escapeMd(a.text)} \`${a.at.slice(11, 19)}\``).join('\n') || '• No recent activity';
    const csText = appSettings.codespaceName ? `\`${escapeMd(appSettings.codespaceName)}\`` : '⚠️ Not connected';

    return `☁️ *${escapeMd(appSettings.panelName || 'PAPPY OS')} — Telegram Cloud Panel*\n` +
        '`Premium editable dashboard`\n\n' +
        `*Account*\n• User: \`${id}\`\n• Role: ${ctx.from?.id === OWNER_ID ? '👑 Owner' : '👤 User'}\n• GitHub Codespace: ${csText}\n\n` +
        `*Live Resources*\n• CPU: \`${stats.cpu}\`\n• RAM: \`${escapeMd(stats.ram)}\`\n• Storage: \`${stats.storage}\` / \`${escapeMd(String(profile.quota.storageMb))} MB\`\n• Network: \`${escapeMd(stats.network)}\`\n\n` +
        `*Deployments*\n• Active: \`${active}\`\n• Total: \`${(profile.deployments || []).length}\`\n• Status: ${active ? '🟢 Running' : '⚪ Idle'}\n\n` +
        `*Recent Activity*\n${recent}`;
}

const mainMenu = () => keyboard([
    [{ text: '🚀 Deploy', callback_data: 'menu_deploy' }, { text: '📦 Deployments', callback_data: 'menu_manage' }],
    [{ text: '🖥️ Servers', callback_data: 'menu_servers' }, { text: '💻 Terminal', callback_data: 'menu_terminal' }],
    [{ text: '📁 Files', callback_data: 'menu_files' }, { text: '⬆️ Upload', callback_data: 'menu_upload' }],
    [{ text: '🐙 GitHub', callback_data: 'menu_github' }, { text: '🖼️ Canvas Studio', callback_data: 'menu_canvas' }],
    [{ text: '🔄 Refresh', callback_data: 'action_home' }, { text: '⚙️ Settings', callback_data: 'menu_settings' }],
    [{ text: '💬 Support', url: 'https://t.me/pappylung' }, { text: '📢 Updates', url: 'https://t.me/holypappy' }]
]);

async function renderDashboard(ctx, edit = true) {
    ctx.session.state = 'IDLE';
    const text = await dashboardText(ctx);
    if (edit && ctx.callbackQuery?.message) {
        return ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...mainMenu() }).catch(() => ctx.reply(text, { parse_mode: 'MarkdownV2', ...mainMenu() }));
    }
    return ctx.reply(text, { parse_mode: 'MarkdownV2', ...mainMenu() });
}

bot.use((ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return;
    if (id !== OWNER_ID && !sudoUsers.includes(id)) return ctx.reply('⛔ Unauthorized. Ask the owner for panel access.');
    if (!ctx.session) ctx.session = {};
    ensureUser(String(id), ctx.from || {});
    return next();
});

setInterval(async () => {
    if (!appSettings.codespaceName) return;
    try {
        await execAsync(`gh codespace ssh -c ${shellQuote(appSettings.codespaceName)} "echo ping >/dev/null"`, { timeout: 20000 });
    } catch {
        console.log(`⚠️ Ping failed for ${appSettings.codespaceName} - Codespace likely offline.`);
    }
}, 15 * 60 * 1000);

bot.catch((error, ctx) => {
    console.error('Telegraf recovered update failure:', error);
    if (ctx?.callbackQuery) ctx.answerCbQuery('Recovered from a panel error.', { show_alert: true }).catch(() => {});
});

bot.start(runSafely('start', (ctx) => renderDashboard(ctx, false)));
bot.command(['dashboard', 'home'], runSafely('dashboard-command', (ctx) => renderDashboard(ctx, false)));
bot.command('cancel', runSafely('cancel-command', (ctx) => {
    ctx.session.state = 'IDLE';
    ctx.session.fileAction = null;
    ctx.session.editDeploymentId = null;
    return ctx.reply('✅ Current action cancelled.', { ...mainMenu() });
}));
bot.command('help', runSafely('help-command', (ctx) => ctx.reply('🧭 *PAPPY OS Commands*\n\n/start — open dashboard\n/dashboard — refresh dashboard\n/deploy — deployment engine\n/files — file manager\n/servers — server manager\n/terminal — hosted terminal\n/cancel — cancel current input flow\n/help — this page', { parse_mode: 'Markdown', ...mainMenu() })));
bot.command('deploy', runSafely('deploy-command', (ctx) => renderDeployments(ctx)));
bot.command('files', runSafely('files-command', (ctx) => renderFiles(ctx)));
bot.command('servers', runSafely('servers-command', (ctx) => renderServers(ctx)));
bot.command('terminal', runSafely('terminal-command', (ctx) => openTerminal(ctx)));
bot.action('action_home', runSafely('action_home', async (ctx) => { ctx.answerCbQuery().catch(() => {}); await renderDashboard(ctx, true); }));

bot.action('menu_settings', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const rows = [
        [{ text: '☁️ Set Codespace', callback_data: 'menu_change_cs' }, { text: '🔑 GitHub Token', callback_data: 'menu_github_login' }],
        [{ text: '👤 Manage Sudo', callback_data: 'menu_sudo' }],
        [backHome]
    ];
    ctx.editMessageText('⚙️ *Settings*\n`Dashboard › Settings`\n\nConfigure owner-level access, GitHub CLI auth, and the default Codespace provider.', { parse_mode: 'Markdown', ...keyboard(rows) });
});

bot.action('menu_sudo', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('Only Owner.', { show_alert: true });
    ctx.session.state = 'AWAITING_SUDO_ID';
    const sudoList = sudoUsers.length > 0 ? sudoUsers.map((id) => `\`${id}\``).join(', ') : 'None';
    ctx.editMessageText(`👤 *Sudo Management*\n\nCurrent Sudo IDs: ${sudoList}\n\nSend a Telegram User ID to add or remove.`, { parse_mode: 'Markdown', ...keyboard([[backHome]]) });
});

bot.action('menu_change_cs', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('Only Owner.', { show_alert: true });
    ctx.session.state = 'AWAITING_CODESPACE_NAME';
    ctx.editMessageText(`☁️ *GitHub Codespaces*\n\nCurrent: \`${appSettings.codespaceName || 'None'}\`\n\nSend the exact Codespace name.`, { parse_mode: 'Markdown', ...keyboard([[backHome]]) });
});

bot.action('menu_github_login', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('Only Owner.', { show_alert: true });
    ctx.session.state = 'AWAITING_GITHUB_TOKEN';
    ctx.editMessageText('🔑 *GitHub Authentication*\n\nSend a GitHub token with `repo` and `codespace` scopes. It is piped to `gh auth login --with-token` and not stored in panel data.', { parse_mode: 'Markdown', ...keyboard([[backHome]]) });
});

async function renderServers(ctx) {
    ctx.answerCbQuery().catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    const rows = (profile.servers || []).map((server, idx) => [{ text: `🖥️ ${server.name} · ${server.status || 'saved'}`, callback_data: `server_${idx}` }]);
    rows.push([{ text: '➕ Add SSH Server', callback_data: 'server_add' }, { text: '🏠 Hosted Slot', callback_data: 'server_hosted' }], [backHome]);
    return safeEdit(ctx, '🖥️ *Server Manager*\n`Dashboard › Servers`\n\nManage GitHub Codespaces, custom SSH servers, and the PAPPY hosted terminal slot. Each server record is scoped to your Telegram account.', { parse_mode: 'Markdown', ...keyboard(rows) });
}

bot.action('menu_servers', runSafely('menu_servers', renderServers));

bot.action('server_add', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    ctx.session.state = 'AWAITING_SERVER_SPEC';
    ctx.editMessageText('➕ *Add SSH Server*\n\nSend server details as:\n`name|host|username|password-or-key-path|optional-passphrase`\n\nPrivate key files may be uploaded first and referenced by path inside your isolated workspace.', { parse_mode: 'Markdown', ...keyboard([[{ text: '⬅️ Servers', callback_data: 'menu_servers' }]]) });
});

bot.action(/server_(\d+)/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    const server = profile.servers[Number(ctx.match[1])];
    if (!server) return ctx.answerCbQuery('Server not found', { show_alert: true });
    const stats = await systemStats(userId(ctx));
    const rows = [
        [{ text: '▶️ Start', callback_data: 'noop' }, { text: '⏹️ Stop', callback_data: 'noop' }, { text: '🔄 Restart', callback_data: 'noop' }],
        [{ text: '💻 Terminal', callback_data: 'menu_terminal' }, { text: '📁 Files', callback_data: 'menu_files' }, { text: '📜 Logs', callback_data: 'menu_logs' }],
        [{ text: '⬆️ Upload', callback_data: 'menu_upload' }, { text: '⬇️ Download', callback_data: 'menu_files' }],
        [{ text: '🌱 Environment', callback_data: 'menu_env' }, { text: '🚀 Startup', callback_data: 'menu_startup' }, { text: '⚙️ Settings', callback_data: 'menu_settings' }],
        [{ text: '🗑️ Delete Server', callback_data: `server_delete_${ctx.match[1]}` }],
        [{ text: '⬅️ Servers', callback_data: 'menu_servers' }]
    ];
    ctx.editMessageText(`🖥️ *${escapeMd(server.name)}*\n\nStatus: \`${server.status || 'saved'}\`\nCPU: \`${stats.cpu}\`\nRAM: \`${escapeMd(stats.ram)}\`\nDisk: \`${stats.storage}\`\nNetwork: \`${escapeMd(stats.network)}\``, { parse_mode: 'MarkdownV2', ...keyboard(rows) });
});

bot.action('server_hosted', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    ctx.editMessageText(`🏠 *PAPPY Hosted Terminal*\n\nSlot limit: \`${profile.quota.hostedSlots}\`\nCPU: \`${profile.quota.cpu}\`\nRAM: \`${profile.quota.ramMb} MB\`\nStorage: \`${profile.quota.storageMb} MB\`\n\nOwner accounts are unlimited. User workspaces are isolated under their own account directory.`, { parse_mode: 'Markdown', ...keyboard([[{ text: '🚀 Deploy to Slot', callback_data: 'menu_deploy' }], [{ text: '⬅️ Servers', callback_data: 'menu_servers' }]]) });
});

bot.action(/server_delete_(\d+)/, (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    const removed = profile.servers.splice(Number(ctx.match[1]), 1)[0];
    saveUser(profile);
    addActivity(profile.id, `Deleted server ${removed?.name || 'unknown'}`);
    ctx.editMessageText('🗑️ Server deleted.', { ...keyboard([[{ text: '⬅️ Servers', callback_data: 'menu_servers' }]]) });
});

async function renderFiles(ctx) {
    ctx.answerCbQuery().catch(() => {});
    const id = userId(ctx);
    const rel = ctx.session.filePath || '.';
    const dir = safeJoin(workspaceRoot(id), rel);
    fs.mkdirSync(dir, { recursive: true });
    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 8);
    const rows = entries.map((entry) => {
        const token = pathToken(ctx, path.join(rel, entry.name));
        return [{ text: `${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`.slice(0, 50), callback_data: entry.isDirectory() ? `files_cd_${token}` : `file_view_${token}` }];
    });
    if (rel !== '.') rows.unshift([{ text: '⬆️ Parent Folder', callback_data: `files_cd_${pathToken(ctx, path.dirname(rel))}` }]);
    rows.push(
        [{ text: '🔎 Search', callback_data: 'files_search' }, { text: '⬆️ Upload', callback_data: 'menu_upload' }],
        [{ text: '📦 Compress', callback_data: 'files_compress' }, { text: '🧹 Clear Clipboard', callback_data: 'files_clip_clear' }],
        [backHome]
    );
    const list = entries.map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`).join('\n') || 'Empty workspace';
    return safeEdit(ctx, `📁 *File Manager*\n\`Dashboard › Files › /${rel === '.' ? '' : rel}\`\n\n\`\`\`text\n${list}\n\`\`\``, { parse_mode: 'Markdown', ...keyboard(rows) });
}

bot.action('menu_files', runSafely('menu_files', renderFiles));

bot.action(/files_cd_(.+)/, runSafely('files_cd', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    ctx.session.filePath = tokenPath(ctx, ctx.match[1]);
    return renderFiles(ctx);
}));

bot.action(/file_view_(.+)/, runSafely('file_view', async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const rel = tokenPath(ctx, ctx.match[1]);
    const filePath = safeJoin(workspaceRoot(userId(ctx)), rel);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return ctx.answerCbQuery('File not found.', { show_alert: true });
    const rows = [
        [{ text: '👁️ Preview', callback_data: `file_preview_${ctx.match[1]}` }, { text: '⬇️ Download', callback_data: `file_download_${ctx.match[1]}` }],
        [{ text: '✏️ Rename', callback_data: `file_rename_${ctx.match[1]}` }, { text: '📋 Copy', callback_data: `file_copy_${ctx.match[1]}` }],
        [{ text: '🚚 Move', callback_data: `file_move_${ctx.match[1]}` }, { text: '🗑️ Delete', callback_data: `file_delete_${ctx.match[1]}` }],
        [{ text: '⬅️ Files', callback_data: 'menu_files' }]
    ];
    return safeEdit(ctx, `📄 *${escapeMd(path.basename(filePath))}*\n\nSize: \`${fs.statSync(filePath).size} bytes\`\nPath: \`${escapeMd(rel)}\``, { parse_mode: 'MarkdownV2', ...keyboard(rows) });
}));

bot.action(/file_preview_(.+)/, runSafely('file_preview', async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const rel = tokenPath(ctx, ctx.match[1]);
    const filePath = safeJoin(workspaceRoot(userId(ctx)), rel);
    if (fs.statSync(filePath).size > 64 * 1024) return ctx.answerCbQuery('Preview limited to 64 KB. Use Download.', { show_alert: true });
    const preview = fs.readFileSync(filePath, 'utf8');
    return safeEdit(ctx, `👁️ *Preview: ${escapeMd(path.basename(filePath))}*\n\n\`\`\`text\n${clip(preview, 3000)}\n\`\`\``, { parse_mode: 'Markdown', ...keyboard([[{ text: '⬅️ File', callback_data: `file_view_${ctx.match[1]}` }]]) });
}));

bot.action(/file_download_(.+)/, runSafely('file_download', async (ctx) => {
    ctx.answerCbQuery('Preparing download...').catch(() => {});
    const rel = tokenPath(ctx, ctx.match[1]);
    const filePath = safeJoin(workspaceRoot(userId(ctx)), rel);
    return ctx.replyWithDocument({ source: filePath, filename: path.basename(filePath) });
}));

bot.action(/file_(rename|move|delete)_(.+)/, runSafely('file_mutation', async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const action = ctx.match[1];
    const rel = tokenPath(ctx, ctx.match[2]);
    if (action === 'delete') {
        ctx.session.fileAction = { action, rel };
        return safeEdit(ctx, `🗑️ Delete \`${rel}\`?`, { parse_mode: 'Markdown', ...keyboard([[{ text: '✅ Confirm Delete', callback_data: 'file_confirm_delete' }, { text: '❌ Cancel', callback_data: 'menu_files' }]]) });
    }
    ctx.session.state = action === 'rename' ? 'AWAITING_FILE_RENAME' : 'AWAITING_FILE_MOVE';
    ctx.session.fileAction = { action, rel };
    return safeEdit(ctx, action === 'rename' ? '✏️ Send the new file name.' : '🚚 Send the destination path inside your workspace.', { ...keyboard([[{ text: '❌ Cancel', callback_data: 'menu_files' }]]) });
}));

bot.action(/file_copy_(.+)/, runSafely('file_copy', async (ctx) => {
    ctx.answerCbQuery('Copied to panel clipboard.').catch(() => {});
    ctx.session.clipboard = { rel: tokenPath(ctx, ctx.match[1]), mode: 'copy' };
    return safeEdit(ctx, '📋 File copied. Open a folder and choose paste by sending destination path after Move, or use the file menu again.', { ...keyboard([[{ text: '⬅️ Files', callback_data: 'menu_files' }]]) });
}));

bot.action('file_confirm_delete', runSafely('file_confirm_delete', async (ctx) => {
    const action = ctx.session.fileAction;
    if (!action?.rel) return ctx.answerCbQuery('Nothing selected.', { show_alert: true });
    const target = safeJoin(workspaceRoot(userId(ctx)), action.rel);
    await fs.promises.rm(target, { recursive: true, force: true });
    ctx.session.fileAction = null;
    addActivity(userId(ctx), `Deleted ${action.rel}`);
    return renderFiles(ctx);
}));

bot.action('files_compress', runSafely('files_compress', async (ctx) => {
    ctx.answerCbQuery('Compressing workspace...').catch(() => {});
    const id = userId(ctx);
    const rel = ctx.session.filePath || '.';
    const source = safeJoin(workspaceRoot(id), rel);
    const archive = safeJoin(uploadsRoot(id), `archive-${Date.now()}.tar.gz`);
    await execAsync(`tar -czf ${shellQuote(archive)} -C ${shellQuote(source)} .`, { timeout: UPLOAD_TIMEOUT_MS });
    addActivity(id, `Compressed /${rel}`);
    return ctx.replyWithDocument({ source: archive, filename: path.basename(archive) });
}));

bot.action('files_search', runSafely('files_search', async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    ctx.session.state = 'AWAITING_FILE_SEARCH';
    return safeEdit(ctx, '🔎 Send a filename or text pattern to search inside your workspace.', { ...keyboard([[{ text: '❌ Cancel', callback_data: 'menu_files' }]]) });
}));

bot.action('files_clip_clear', runSafely('files_clip_clear', async (ctx) => {
    ctx.session.clipboard = null;
    return ctx.answerCbQuery('Clipboard cleared.');
}));

bot.action('menu_upload', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    ctx.session.state = 'AWAITING_UPLOAD';
    ctx.editMessageText('⬆️ *Smart Upload Engine*\n\nSend a ZIP/TAR/TAR.GZ, project file, or GitHub/Git clone URL. PAPPY OS will isolate it, extract archives, detect runtime files, suggest startup, and save deployment metadata.', { parse_mode: 'Markdown', ...keyboard([[{ text: '⬅️ Files', callback_data: 'menu_files' }, backHome]]) });
});

function detectProject(projectDir) {
    const exists = (name) => fs.existsSync(path.join(projectDir, name));
    const candidates = [
        ['index.js', 'node index.js'], ['main.js', 'node main.js'], ['app.js', 'node app.js'], ['server.js', 'node server.js'], ['bot.js', 'node bot.js'],
        ['start.sh', 'bash start.sh'], ['main.py', 'python3 main.py'], ['app.py', 'python3 app.py'], ['manage.py', 'python3 manage.py'],
        ['Cargo.toml', 'cargo run --release'], ['go.mod', 'go run .'], ['Dockerfile', 'docker build -t pappy-app . && docker run pappy-app'],
        ['pom.xml', 'mvn spring-boot:run'], ['build.gradle', './gradlew run'], ['composer.json', 'php -S 0.0.0.0:8000'], ['artisan', 'php artisan serve --host=0.0.0.0'],
        ['bun.lockb', 'bun start'], ['deno.json', 'deno task start']
    ];
    const startup = candidates.find(([file]) => exists(file));
    const packageManager = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : exists('bun.lockb') ? 'bun' : exists('package-lock.json') ? 'npm' : 'npm';
    const runtime = exists('Dockerfile') ? 'Docker' : exists('package.json') ? 'Node.js' : exists('requirements.txt') || exists('pyproject.toml') ? 'Python' : exists('go.mod') ? 'Go' : exists('Cargo.toml') ? 'Rust' : exists('pom.xml') || exists('build.gradle') ? 'Java' : exists('composer.json') || exists('artisan') ? 'PHP' : exists('deno.json') ? 'Deno' : exists('bun.lockb') ? 'Bun' : 'Static/Unknown';
    const install = exists('package.json') ? `${packageManager} install` : exists('requirements.txt') ? 'pip install -r requirements.txt' : exists('pyproject.toml') ? 'pip install .' : exists('go.mod') ? 'go mod download' : exists('Cargo.toml') ? 'cargo fetch' : exists('pom.xml') ? 'mvn dependency:resolve' : exists('composer.json') ? 'composer install' : 'No dependency install detected';
    return { runtime, packageManager, install, startupFile: startup?.[0] || 'index.js', startupCommand: startup?.[1] || 'node index.js', detected: Boolean(startup) };
}

async function registerProject(ctx, projectDir, name) {
    const id = userId(ctx);
    const profile = ensureUser(id, ctx.from || {});
    const detection = detectProject(projectDir);
    const deployment = {
        id: shortId(),
        name: slug(name),
        path: path.relative(workspaceRoot(id), projectDir),
        provider: 'pappy-hosted',
        status: 'staged',
        runtime: detection.runtime,
        install: detection.install,
        startup: detection.startupCommand,
        startupFile: detection.startupFile,
        createdAt: new Date().toISOString(),
        restartCount: 0
    };
    profile.deployments.unshift(deployment);
    saveUser(profile);
    addActivity(id, `Staged ${deployment.name} (${detection.runtime})`);
    ctx.session.pendingDeployment = deployment.id;
    const status = detection.detected ? '✅ Detection succeeded' : '⚠️ Detection fallback used';
    await ctx.reply(`🚀 *Project Staged*\n\n${status}\nRuntime: \`${detection.runtime}\`\nInstall: \`${detection.install}\`\nStartup: \`${detection.startupCommand}\`\n\nUse this startup command?`, { parse_mode: 'Markdown', ...keyboard([[{ text: '✅ Use', callback_data: `startup_use_${deployment.id}` }, { text: '✏️ Edit', callback_data: `startup_edit_${deployment.id}` }], [{ text: '⏭️ Skip', callback_data: `startup_skip_${deployment.id}` }, { text: '📜 Logs', callback_data: 'menu_logs' }], [backHome]]) });
}

async function handleGitUrl(ctx, text) {
    const id = userId(ctx);
    const projectName = slug(path.basename(text.replace(/\.git$/, '')));
    const target = safeJoin(workspaceRoot(id), `${projectName}-${shortId()}`);
    const msg = await ctx.reply(`⏳ Cloning \`${text}\`...`, { parse_mode: 'Markdown' });
    try {
        await execAsync(`git clone --depth 1 ${shellQuote(text)} ${shellQuote(target)}`, { timeout: 120000, maxBuffer: 1024 * 1024 * 4 });
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '✅ Clone complete. Running smart detection...');
        await registerProject(ctx, target, projectName);
    } catch (error) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Clone failed:\n\`\`\`text\n${clip(error.stderr || error.message, 1000)}\n\`\`\``, { parse_mode: 'Markdown' });
    }
}

bot.on('document', async (ctx) => {
    if (ctx.session.state !== 'AWAITING_UPLOAD') return ctx.reply('Tip: open Upload first so I can stage this file safely.', { ...mainMenu() });
    const id = userId(ctx);
    const doc = ctx.message.document;
    const uploadPath = safeJoin(uploadsRoot(id), `${Date.now()}-${slug(doc.file_name)}`);
    const projectDir = safeJoin(workspaceRoot(id), `${slug(doc.file_name.replace(/\.(zip|rar|7z|tar|tgz|tar\.gz)$/i, ''))}-${shortId()}`);
    fs.mkdirSync(projectDir, { recursive: true });
    const msg = await ctx.reply(`⬇️ Downloading \`${doc.file_name}\`...`, { parse_mode: 'Markdown' });
    try {
        const link = await ctx.telegram.getFileLink(doc.file_id);
        const response = await fetch(link.href);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(uploadPath, buffer);
        const lower = doc.file_name.toLowerCase();
        if (lower.endsWith('.zip')) {
            await execAsync(`unzip -oq ${shellQuote(uploadPath)} -d ${shellQuote(projectDir)}`, { timeout: UPLOAD_TIMEOUT_MS });
        } else if (lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
            await execAsync(`tar -xf ${shellQuote(uploadPath)} -C ${shellQuote(projectDir)}`, { timeout: UPLOAD_TIMEOUT_MS });
        } else if (lower.endsWith('.rar')) {
            await execAsync(`command -v unrar >/dev/null && unrar x -o+ ${shellQuote(uploadPath)} ${shellQuote(projectDir)} || bsdtar -xf ${shellQuote(uploadPath)} -C ${shellQuote(projectDir)}`, { timeout: UPLOAD_TIMEOUT_MS });
        } else if (lower.endsWith('.7z')) {
            await execAsync(`command -v 7z >/dev/null && 7z x -y ${shellQuote(uploadPath)} -o${shellQuote(projectDir)} || bsdtar -xf ${shellQuote(uploadPath)} -C ${shellQuote(projectDir)}`, { timeout: UPLOAD_TIMEOUT_MS });
        } else {
            fs.copyFileSync(uploadPath, path.join(projectDir, doc.file_name));
        }
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '✅ Upload processed. Running startup detection...');
        await registerProject(ctx, projectDir, doc.file_name);
    } catch (error) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Upload failed:\n\`\`\`text\n${clip(error.stderr || error.message, 1000)}\n\`\`\``, { parse_mode: 'Markdown' });
    }
});

function renderDeployments(ctx) {
    ctx.answerCbQuery().catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    const rows = (profile.deployments || []).slice(0, 8).map((d) => [{ text: `${d.status === 'running' ? '🟢' : '⚪'} ${d.name} · ${d.runtime}`, callback_data: `deploy_${d.id}` }]);
    rows.push([{ text: '⬆️ Upload Project', callback_data: 'menu_upload' }, { text: '🔗 Git Clone URL', callback_data: 'deploy_git' }], [backHome]);
    return safeEdit(ctx, '🚀 *Deployment Engine*\n`Dashboard › Deployments`\n\n`Upload → Detect → Extract → Install → Runtime → Startup → Deploy → Logs → Running`\n\nChoose an existing project or upload/import a new one.', { parse_mode: 'Markdown', ...keyboard(rows) });
}

bot.action('menu_deploy', runSafely('menu_deploy', renderDeployments));

bot.action('deploy_git', (ctx) => { ctx.answerCbQuery().catch(() => {}); ctx.session.state = 'AWAITING_GIT_URL'; ctx.editMessageText('🔗 Send a GitHub or Git clone URL to import.', { ...keyboard([[backHome]]) }); });

bot.action(/deploy_(.+)/, (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    const d = profile.deployments.find((item) => item.id === ctx.match[1]);
    if (!d) return ctx.answerCbQuery('Deployment not found', { show_alert: true });
    const rows = [[{ text: '▶️ Start', callback_data: `run_${d.id}` }, { text: '🔄 Restart', callback_data: `run_${d.id}` }, { text: '⏹️ Stop', callback_data: `stop_${d.id}` }], [{ text: '📜 Logs', callback_data: `logs_${d.id}` }, { text: '✏️ Startup', callback_data: `startup_edit_${d.id}` }], [{ text: '⬅️ Deployments', callback_data: 'menu_deploy' }]];
    ctx.editMessageText(`🚀 *${escapeMd(d.name)}*\n\nStatus: \`${d.status}\`\nRuntime: \`${d.runtime}\`\nStartup: \`${escapeMd(d.startup)}\`\nPath: \`${escapeMd(d.path)}\``, { parse_mode: 'MarkdownV2', ...keyboard(rows) });
});

bot.action(/startup_(use|skip|edit)_(.+)/, (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const mode = ctx.match[1];
    const id = ctx.match[2];
    if (mode === 'edit') {
        ctx.session.state = 'AWAITING_STARTUP_CMD';
        ctx.session.editDeploymentId = id;
        return ctx.editMessageText('✏️ Send the startup command for this deployment.', { ...keyboard([[backHome]]) });
    }
    addActivity(userId(ctx), `Accepted startup for ${id}`);
    return ctx.editMessageText('✅ Startup saved. You can deploy from the Deployments menu.', { ...keyboard([[{ text: '🚀 Deployments', callback_data: 'menu_deploy' }], [backHome]]) });
});

bot.action(/run_(.+)/, async (ctx) => {
    ctx.answerCbQuery('Starting...').catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    const d = profile.deployments.find((item) => item.id === ctx.match[1]);
    if (!d) return ctx.answerCbQuery('Deployment not found', { show_alert: true });
    const projectDir = safeJoin(workspaceRoot(profile.id), d.path);
    const logFile = path.join(logsRoot(profile.id), `${d.id}.log`);
    const msg = await ctx.reply(`⏳ Starting ${d.name}...`);
    const child = spawn('bash', ['-lc', `${d.install && !d.install.startsWith('No ') ? d.install : 'true'}; ${d.startup}`], { cwd: projectDir, env: { ...process.env, HOME: userRoot(profile.id), PAPPY_USER_ROOT: userRoot(profile.id) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on('error', (error) => {
        fs.appendFileSync(logFile, `\n[PAPPY supervisor] process error: ${error.message}\n`);
    });
    child.on('exit', (code, signal) => {
        fs.appendFileSync(logFile, `\n[PAPPY supervisor] exited code=${code} signal=${signal || 'none'} at ${new Date().toISOString()}\n`);
        ACTIVE_PROCESSES.delete(activeKey(profile.id, d.id));
    });
    child.unref();
    ACTIVE_PROCESSES.set(activeKey(profile.id, d.id), child);
    d.status = 'running';
    d.pid = child.pid;
    d.lastStartedAt = new Date().toISOString();
    saveUser(profile);
    addActivity(profile.id, `Started ${d.name}`);
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `🟢 *${d.name}* is running.\nPID: \`${child.pid}\`\nLogs: \`${path.relative(userRoot(profile.id), logFile)}\``, { parse_mode: 'Markdown', ...keyboard([[{ text: '📜 Live Logs', callback_data: `logs_${d.id}` }, { text: '⏹️ Stop', callback_data: `stop_${d.id}` }], [backHome]]) });
});

bot.action(/stop_(.+)/, async (ctx) => {
    ctx.answerCbQuery('Stopping...').catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    const d = profile.deployments.find((item) => item.id === ctx.match[1]);
    const child = ACTIVE_PROCESSES.get(activeKey(profile.id, ctx.match[1]));
    if (child?.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
        ACTIVE_PROCESSES.delete(activeKey(profile.id, ctx.match[1]));
    } else if (d?.pid) {
        try { process.kill(d.pid, 'SIGTERM'); } catch {}
    }
    if (d) d.status = 'stopped';
    saveUser(profile);
    addActivity(profile.id, `Stopped ${d?.name || ctx.match[1]}`);
    ctx.reply('⏹️ Deployment stopped.', { ...mainMenu() });
});

bot.action(/logs_(.+)|menu_logs/, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const id = userId(ctx);
    const logFile = ctx.match?.[1] ? path.join(logsRoot(id), `${ctx.match[1]}.log`) : null;
    const output = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-3000) : 'No logs yet.';
    const deploymentId = ctx.match?.[1] || 'none';
    ctx.editMessageText(`📜 *Live Logs*\n\n\`\`\`text\n${clip(output, 3000)}\n\`\`\``, { parse_mode: 'Markdown', ...keyboard([[{ text: '⏸️ Pause', callback_data: 'logs_pause' }, { text: '▶️ Refresh', callback_data: deploymentId === 'none' ? 'menu_logs' : `logs_${deploymentId}` }, { text: '⬇️ Download Logs', callback_data: deploymentId === 'none' ? 'logs_download_none' : `logs_download_${deploymentId}` }], [backHome]]) }).catch(() => ctx.reply(clip(output, 3000)));
});

bot.action('logs_pause', runSafely('logs_pause', (ctx) => ctx.answerCbQuery('Log auto-refresh paused.')));

bot.action(/logs_download_(.+)/, runSafely('logs_download', async (ctx) => {
    ctx.answerCbQuery('Preparing logs...').catch(() => {});
    const deploymentId = ctx.match[1];
    if (deploymentId === 'none') return ctx.answerCbQuery('No deployment log selected.', { show_alert: true });
    const logFile = path.join(logsRoot(userId(ctx)), `${deploymentId}.log`);
    if (!fs.existsSync(logFile)) return ctx.answerCbQuery('No log file exists yet.', { show_alert: true });
    return ctx.replyWithDocument({ source: logFile, filename: `${deploymentId}.log` });
}));

bot.action('menu_manage', runSafely('menu_manage', renderDeployments));

function openTerminal(ctx) {
    ctx.answerCbQuery().catch(() => {});
    ctx.session.state = 'AWAITING_TERMINAL_CMD';
    return safeEdit(ctx, '💻 *Live Terminal*\n`Dashboard › Terminal`\n\nProvider: PAPPY hosted workspace. Commands execute inside your isolated workspace with timeout protection and command history.\n\nSend a command. `/exit` returns to the dashboard.', { parse_mode: 'Markdown', ...keyboard([[{ text: '⛔ Interrupt', callback_data: 'terminal_interrupt' }, { text: '🔁 Reconnect', callback_data: 'menu_terminal' }], [{ text: '🧹 Clear', callback_data: 'terminal_clear' }, { text: '⬅️ Back', callback_data: 'action_home' }]]) });
}

bot.action('menu_terminal', runSafely('menu_terminal', openTerminal));

bot.action('terminal_clear', runSafely('terminal_clear', async (ctx) => {
    const profile = ensureUser(userId(ctx), ctx.from || {});
    profile.terminalHistory = [];
    saveUser(profile);
    return openTerminal(ctx);
}));

bot.action('terminal_interrupt', runSafely('terminal_interrupt', (ctx) => ctx.answerCbQuery('No foreground terminal command is attached. Long-running deployments can be stopped from Deployments.', { show_alert: true })));

bot.action('menu_github', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    ctx.editMessageText('🐙 *GitHub Integration*\n`Dashboard › GitHub`\n\nManage repositories, branches, commits, pull/push, releases, webhooks, and Codespaces through the authenticated GitHub CLI/OAuth account.', { parse_mode: 'Markdown', ...keyboard([[{ text: '🔑 Connect', callback_data: 'menu_github_login' }, { text: '🚪 Logout', callback_data: 'github_logout' }], [{ text: '📚 Repositories', callback_data: 'github_repos' }, { text: '🌿 Branches', callback_data: 'github_branches' }], [{ text: '⬇️ Pull', callback_data: 'github_pull' }, { text: '⬆️ Push', callback_data: 'github_push' }], [{ text: '☁️ Codespaces', callback_data: 'github_codespaces' }, { text: '🔗 Import Repo', callback_data: 'deploy_git' }], [backHome]]) });
});

bot.action(['github_repos', 'github_branches', 'github_pull', 'github_push', 'github_codespaces', 'github_logout'], runSafely('github_actions', async (ctx) => {
    const action = ctx.callbackQuery.data;
    ctx.answerCbQuery('Checking GitHub CLI...').catch(() => {});
    try {
        if (action === 'github_logout') {
            await execAsync('gh auth logout --hostname github.com --yes', { timeout: 15000 });
            addActivity(userId(ctx), 'Logged out GitHub CLI');
            return safeEdit(ctx, '🚪 GitHub account disconnected from this host.', { ...keyboard([[{ text: '⬅️ GitHub', callback_data: 'menu_github' }]]) });
        }
        const commands = {
            github_repos: 'gh repo list --limit 20',
            github_branches: 'git branch -a || true',
            github_pull: 'git pull --ff-only || true',
            github_push: 'git status --short && echo \"Push requires a selected repository workspace.\"',
            github_codespaces: 'gh codespace list --limit 20'
        };
        const { stdout, stderr } = await execAsync(commands[action], { cwd: workspaceRoot(userId(ctx)), timeout: 30000, maxBuffer: 1024 * 1024 });
        return safeEdit(ctx, `🐙 *GitHub Result*\n\n\`\`\`text\n${clip(stdout || stderr, 3000)}\n\`\`\``, { parse_mode: 'Markdown', ...keyboard([[{ text: '⬅️ GitHub', callback_data: 'menu_github' }]]) });
    } catch (error) {
        return safeEdit(ctx, `❌ GitHub action failed gracefully.\n\n\`\`\`text\n${clip(error.stderr || error.message, 1200)}\n\`\`\``, { parse_mode: 'Markdown', ...keyboard([[{ text: '⬅️ GitHub', callback_data: 'menu_github' }]]) });
    }
}));

bot.action('menu_canvas', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    ctx.editMessageText('🖼️ *Canvas Image Studio*\n`Dashboard › Canvas`\n\nA first-class asset editor for deployments: crop, resize, rotate, flip, canvas, layers, brush, shapes, text, background removal, filters, brightness, contrast, blur, stickers, undo, redo, history, preview, export, and batch editing.', { parse_mode: 'Markdown', ...keyboard([[{ text: '🚀 Open Studio', url: process.env.CANVAS_STUDIO_URL || 'https://t.me/pappylung' }], [{ text: '🧾 Feature Map', callback_data: 'canvas_features' }, { text: '📁 Use Project Asset', callback_data: 'menu_files' }], [backHome]]) });
});

bot.action('canvas_features', runSafely('canvas_features', (ctx) => safeEdit(ctx, '🖼️ *Canvas Tools*\n\n• Crop / Resize / Rotate / Flip\n• Canvas / Layers / Brush / Shapes / Text\n• Background Removal / Stickers / Filters\n• Brightness / Contrast / Blur / Color correction\n• Undo / Redo / History / Preview\n• Export PNG, JPG, WebP\n• Batch resize and export\n\nSet `CANVAS_STUDIO_URL` to your Telegram Mini App URL for live editing.', { parse_mode: 'Markdown', ...keyboard([[{ text: '⬅️ Canvas', callback_data: 'menu_canvas' }]]) })));

bot.action('menu_env', runSafely('menu_env', async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    const keys = Object.keys(profile.env || {});
    return safeEdit(ctx, `🌱 *Environment Variables*\n\nStored keys: \`${keys.length ? keys.join(', ') : 'none'}\`\n\nSend variables as \`KEY=value\` to save them to your isolated profile.`, { parse_mode: 'Markdown', ...keyboard([[{ text: '➕ Set Variable', callback_data: 'env_set' }, { text: '🧹 Clear All', callback_data: 'env_clear' }], [backHome]]) });
}));

bot.action('env_set', runSafely('env_set', async (ctx) => {
    ctx.session.state = 'AWAITING_ENV_VAR';
    return safeEdit(ctx, '🌱 Send environment variable as `KEY=value`.', { parse_mode: 'Markdown', ...keyboard([[{ text: '❌ Cancel', callback_data: 'menu_env' }]]) });
}));

bot.action('env_clear', runSafely('env_clear', async (ctx) => {
    const profile = ensureUser(userId(ctx), ctx.from || {});
    profile.env = {};
    saveUser(profile);
    addActivity(profile.id, 'Cleared environment variables');
    return safeEdit(ctx, '✅ Environment variables cleared.', { ...keyboard([[{ text: '⬅️ Environment', callback_data: 'menu_env' }]]) });
}));

bot.action('menu_startup', runSafely('menu_startup', async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    const profile = ensureUser(userId(ctx), ctx.from || {});
    const rows = (profile.deployments || []).slice(0, 10).map((d) => [{ text: `🚀 ${d.name}: ${d.startup}`.slice(0, 60), callback_data: `startup_edit_${d.id}` }]);
    rows.push([backHome]);
    return safeEdit(ctx, '🚀 *Startup Manager*\n\nSelect a deployment to edit its startup command.', { parse_mode: 'Markdown', ...keyboard(rows) });
}));

bot.action('noop', runSafely('noop', (ctx) => ctx.answerCbQuery('This control is informational for the current provider.')));

bot.on('text', async (ctx) => {
    try {
        const text = ctx.message.text.trim();
        const state = ctx.session.state;
        const id = userId(ctx);

        if (state === 'AWAITING_SUDO_ID') {
            const targetId = Number.parseInt(text, 10);
            if (Number.isNaN(targetId)) return ctx.reply('❌ Invalid ID.');
            sudoUsers = sudoUsers.includes(targetId) ? sudoUsers.filter((value) => value !== targetId) : [...sudoUsers, targetId];
            saveSudo();
            ctx.session.state = 'IDLE';
            return ctx.reply(`✅ Sudo list updated for \`${targetId}\`.`, { parse_mode: 'Markdown', ...mainMenu() });
        }

        if (state === 'AWAITING_GITHUB_TOKEN') {
            const msg = await ctx.reply('⏳ Authenticating with GitHub...');
            try {
                await execAsync(`printf %s ${shellQuote(text)} | gh auth login --with-token`, { timeout: 30000 });
                const { stdout } = await execAsync('gh auth status', { timeout: 15000 });
                ctx.session.state = 'IDLE';
                addActivity(id, 'Connected GitHub CLI');
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ *GitHub Login Successful*\n\n\`\`\`text\n${clip(stdout, 1000)}\n\`\`\``, { parse_mode: 'Markdown', ...mainMenu() });
            } catch (error) {
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Authentication failed:\n\`\`\`text\n${clip(error.stderr || error.message, 1000)}\n\`\`\``, { parse_mode: 'Markdown' });
            }
        }

        if (state === 'AWAITING_CODESPACE_NAME') {
            const msg = await ctx.reply(`⏳ Verifying \`${text}\`...`, { parse_mode: 'Markdown' });
            try {
                await execAsync(`gh codespace view -c ${shellQuote(text)}`, { timeout: 30000 });
                appSettings.codespaceName = text;
                saveSettings();
                ctx.session.state = 'IDLE';
                addActivity(id, `Set Codespace ${text}`);
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Target Codespace updated to \`${text}\`.`, { parse_mode: 'Markdown', ...mainMenu() });
            } catch (error) {
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Codespace not accessible:\n\`\`\`text\n${clip(error.stderr || error.message, 1000)}\n\`\`\`` , { parse_mode: 'Markdown' });
            }
        }

        if (state === 'AWAITING_SERVER_SPEC') {
            const [name, host, username, secret, passphrase = ''] = text.split('|').map((part) => part?.trim());
            if (!name || !host || !username || !secret) return ctx.reply('❌ Invalid format. Use `name|host|username|password-or-key-path|optional-passphrase`.', { parse_mode: 'Markdown' });
            const profile = ensureUser(id, ctx.from || {});
            profile.servers.push({ name, host, username, auth: secret.startsWith('/') ? 'key' : 'password', secretRef: secret, passphrase: Boolean(passphrase), status: 'saved', createdAt: new Date().toISOString() });
            saveUser(profile);
            ctx.session.state = 'IDLE';
            addActivity(id, `Added SSH server ${name}`);
            return ctx.reply('✅ SSH server saved to your isolated profile.', { ...mainMenu() });
        }

        if (state === 'AWAITING_FILE_SEARCH') {
            const root = workspaceRoot(id);
            const { stdout } = await execAsync(`find ${shellQuote(root)} -maxdepth 5 -iname ${shellQuote(`*${text}*`)} -printf '%P\n' | head -25`, { timeout: 10000 });
            ctx.session.state = 'IDLE';
            return ctx.reply(`🔎 *Search Results*\n\n\`\`\`text\n${clip(stdout || 'No files matched.', 2000)}\n\`\`\``, { parse_mode: 'Markdown', ...keyboard([[{ text: '⬅️ Files', callback_data: 'menu_files' }]]) });
        }

        if (state === 'AWAITING_FILE_RENAME' || state === 'AWAITING_FILE_MOVE') {
            const action = ctx.session.fileAction;
            if (!action?.rel) return ctx.reply('❌ No file selected.', { ...mainMenu() });
            const source = safeJoin(workspaceRoot(id), action.rel);
            const destinationRel = state === 'AWAITING_FILE_RENAME' ? path.join(path.dirname(action.rel), path.basename(text)) : text;
            const destination = safeJoin(workspaceRoot(id), destinationRel);
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            await fs.promises.rename(source, destination);
            ctx.session.fileAction = null;
            ctx.session.state = 'IDLE';
            addActivity(id, `${state === 'AWAITING_FILE_RENAME' ? 'Renamed' : 'Moved'} ${action.rel}`);
            return ctx.reply('✅ File operation completed.', { ...keyboard([[{ text: '📁 Files', callback_data: 'menu_files' }], [backHome]]) });
        }

        if (state === 'AWAITING_ENV_VAR') {
            const match = text.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
            if (!match) return ctx.reply('❌ Invalid format. Use `KEY=value`.', { parse_mode: 'Markdown' });
            const profile = ensureUser(id, ctx.from || {});
            profile.env[match[1]] = match[2];
            saveUser(profile);
            ctx.session.state = 'IDLE';
            addActivity(id, `Updated env ${match[1]}`);
            return ctx.reply(`✅ Saved \`${match[1]}\` to your isolated environment.`, { parse_mode: 'Markdown', ...keyboard([[{ text: '🌱 Environment', callback_data: 'menu_env' }], [backHome]]) });
        }

        if (state === 'AWAITING_GIT_URL' || state === 'AWAITING_UPLOAD') {
            if (!/^https?:\/\/.+|git@.+:.+/.test(text)) return ctx.reply('❌ Send a valid GitHub/Git URL or upload a document.');
            ctx.session.state = 'IDLE';
            return handleGitUrl(ctx, text);
        }

        if (state === 'AWAITING_STARTUP_CMD') {
            const profile = ensureUser(id, ctx.from || {});
            const d = profile.deployments.find((item) => item.id === ctx.session.editDeploymentId);
            if (!d) return ctx.reply('❌ Deployment not found.');
            d.startup = text;
            saveUser(profile);
            ctx.session.state = 'IDLE';
            addActivity(id, `Updated startup for ${d.name}`);
            return ctx.reply(`✅ Startup saved: \`${text}\``, { parse_mode: 'Markdown', ...mainMenu() });
        }

        if (state === 'AWAITING_TERMINAL_CMD') {
            if (text.toLowerCase() === '/exit') return renderDashboard(ctx, false);
            if (!validateTerminalCommand(text)) return ctx.reply('🛡️ Command blocked by PAPPY OS safety policy. Use workspace-scoped commands only.');
            const msg = await ctx.reply(`⏳ Executing: \`${text}\``, { parse_mode: 'Markdown' });
            const started = Date.now();
            try {
                const { stdout, stderr } = await execAsync(text, { cwd: workspaceRoot(id), env: { ...process.env, HOME: userRoot(id), PAPPY_USER_ROOT: userRoot(id) }, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
                const profile = ensureUser(id, ctx.from || {});
                profile.terminalHistory = [{ command: text, exitCode: 0, at: new Date().toISOString() }, ...(profile.terminalHistory || [])].slice(0, 20);
                saveUser(profile);
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `💻 *Terminal*\nPrompt: \`${id}@pappy:${path.basename(workspaceRoot(id))}$\`\nExit: \`0\` · ${Date.now() - started}ms\n\n\`\`\`text\n${clip(stdout || stderr)}\n\`\`\``, { parse_mode: 'Markdown', ...keyboard([[{ text: '🧹 Clear', callback_data: 'menu_terminal' }, backHome]]) });
            } catch (error) {
                return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ *Terminal Error*\nExit: \`${error.code || 'timeout'}\`\n\n\`\`\`text\n${clip(error.stderr || error.message)}\n\`\`\``, { parse_mode: 'Markdown', ...keyboard([[{ text: '↩️ Terminal', callback_data: 'menu_terminal' }, backHome]]) });
            }
        }

        return ctx.reply('Use the dashboard buttons to navigate PAPPY OS.', { ...mainMenu() });
    } catch (error) {
        console.error('Text Handler Error:', error);
        return ctx.reply('❌ Panel error. Check server logs.');
    }
});

const launchBot = async () => {
    try {
        await bot.telegram.callApi('getUpdates', { offset: -1, limit: 1, timeout: 0 });
    } catch {}
    bot.launch().then(() => console.log('✅ PAPPY OS Telegram Cloud Panel Online.')).catch((err) => {
        console.error('Launch failed:', err.message);
        setTimeout(launchBot, 5000);
    });
};
launchBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
