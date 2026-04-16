require('dotenv').config();
const { Telegraf, session } = require('telegraf'); 
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = util.promisify(exec); 

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

const OWNER_ID = parseInt(process.env.OWNER_ID);

// --- Storage Setup ---
const SUDO_FILE = path.join(__dirname, 'sudo.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const loadJson = (file, fallback) => {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : fallback; } 
    catch { return fallback; }
};

let sudoUsers = loadJson(SUDO_FILE, []);
const saveSudo = () => fs.writeFileSync(SUDO_FILE, JSON.stringify(sudoUsers));

let appSettings = loadJson(SETTINGS_FILE, { codespaceName: process.env.CODESPACE_NAME || '' });
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings));

// --- ANTI-OFFLINE LOGIC: Global Error Catching ---
process.on('uncaughtException', (err) => console.error('🔥 Caught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled Rejection:', reason));

// --- Keep Codespace Alive ---
setInterval(async () => {
    if (!appSettings.codespaceName) return;
    try {
        await execAsync(`gh codespace ssh -c ${appSettings.codespaceName} "echo 'ping' > /dev/null"`);
    } catch {
        console.log(`⚠️ Ping failed for ${appSettings.codespaceName} - Codespace likely offline.`);
    }
}, 15 * 60 * 1000); 

// --- Auth Middleware ---
bot.use((ctx, next) => {
    const userId = ctx.from?.id;
    if (userId !== OWNER_ID && !sudoUsers.includes(userId)) return ctx.reply('⛔ Unauthorized.');
    if (!ctx.session) ctx.session = { state: 'IDLE' };
    return next();
});

// --- UI Menu ---
const getMainMenu = () => ({
    reply_markup: {
        inline_keyboard: [
            [
                { text: '🚀 Deploy Bot', callback_data: 'menu_deploy', style: 'primary' },
                { text: '📦 Manage Bots', callback_data: 'menu_manage', style: 'primary' }
            ],
            [
                { text: '💻 Codespace Control', callback_data: 'menu_codespace_panel', style: 'primary' },
                { text: '🖥️ Terminal', callback_data: 'menu_terminal', style: 'danger' }
            ],
            [
                { text: '☁️ Set Codespace', callback_data: 'menu_change_cs', style: 'primary' },
                { text: '🔑 GitHub Login', callback_data: 'menu_github_login', style: 'danger' }
            ],
            [
                { text: '👤 Manage Sudo', callback_data: 'menu_sudo', style: 'success' }, 
                { text: '💬 Support', url: 'https://t.me/pappylung', style: 'success' }
            ],
            [{ text: '📢 Updates', url: 'https://t.me/holypappy', style: 'primary' }]
        ]
    }
});

bot.start((ctx) => {
    ctx.session.state = 'IDLE';
    const csText = appSettings.codespaceName ? `\`${appSettings.codespaceName}\`` : '⚠️ Not Set';
    ctx.reply(`🎛️ **VPS Middleware Online**\nBy @holypappy\n\nTarget Codespace: ${csText}`, { parse_mode: 'Markdown', ...getMainMenu() });
});

bot.action('action_home', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    ctx.session.state = 'IDLE';
    const csText = appSettings.codespaceName ? `\`${appSettings.codespaceName}\`` : '⚠️ Not Set';
    ctx.editMessageText(`🎛️ **VPS Middleware Online**\n\nTarget Codespace: ${csText}\nSelect an operation:`, { parse_mode: 'Markdown', ...getMainMenu() }).catch(() => {});
});

// ==========================================
// 1. SETTINGS & CONFIGURATION
// ==========================================
bot.action('menu_sudo', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('Only Owner.', { show_alert: true });
    ctx.session.state = 'AWAITING_SUDO_ID';
    const sudoList = sudoUsers.length > 0 ? sudoUsers.map(id => `\`${id}\``).join(', ') : 'None';
    
    const menu = { reply_markup: { inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'action_home', style: 'danger' }]] } };
    ctx.editMessageText(`👤 **Sudo Management**\n\nCurrent Sudo IDs: ${sudoList}\n\nSend me a **Telegram User ID** to Add or Remove them.`, { parse_mode: 'Markdown', ...menu });
});

bot.action('menu_change_cs', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('Only Owner.', { show_alert: true });
    ctx.session.state = 'AWAITING_CODESPACE_NAME';
    const menu = { reply_markup: { inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'action_home', style: 'danger' }]] } };
    ctx.editMessageText(`☁️ **Change Target Codespace**\n\nCurrent: \`${appSettings.codespaceName || 'None'}\`\n\nSend me the exact name of your new GitHub Codespace.`, { parse_mode: 'Markdown', ...menu });
});

bot.action('menu_github_login', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id !== OWNER_ID) return ctx.answerCbQuery('Only Owner.', { show_alert: true });
    ctx.session.state = 'AWAITING_GITHUB_TOKEN';
    const menu = { reply_markup: { inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'action_home', style: 'danger' }]] } };
    ctx.editMessageText(`🔑 **GitHub Authentication**\n\nSend your **GitHub Personal Access Token (Classic)**.\n*(Ensure it has \`repo\` and \`codespace\` permissions)*\n\nThis will log the VPS into the new GitHub account.`, { parse_mode: 'Markdown', ...menu });
});

// ==========================================
// 2. CODESPACE CONTROL
// ==========================================
bot.action('menu_codespace_panel', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!appSettings.codespaceName) return ctx.answerCbQuery('⚠️ No Codespace set!', { show_alert: true });
    
    const menu = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🟢 Start Codespace', callback_data: 'cs_start', style: 'success' }, 
                    { text: '🛑 Stop Codespace', callback_data: 'cs_stop', style: 'danger' }
                ],
                [{ text: '📊 Check Status', callback_data: 'cs_status', style: 'primary' }],
                [{ text: '⬅️ Main Menu', callback_data: 'action_home', style: 'primary' }]
            ]
        }
    };
    ctx.editMessageText(`💻 **Codespace Control Panel**\nTarget: \`${appSettings.codespaceName}\``, { parse_mode: 'Markdown', ...menu });
});

bot.action('cs_status', async (ctx) => {
    ctx.answerCbQuery('Checking...').catch(() => {});
    try {
        const { stdout } = await execAsync(`gh codespace list --json name,state | grep ${appSettings.codespaceName}`);
        ctx.reply(`💻 **Codespace Data:**\n\`\`\`json\n${stdout.trim() || 'No data found'}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch {
        ctx.reply('❌ Failed to get status. Check "gh auth status" on VPS.');
    }
});

bot.action('cs_start', async (ctx) => {
    ctx.answerCbQuery('Starting...').catch(() => {});
    ctx.reply('⏳ Sending Wake signal to Codespace...');
    try {
        await execAsync(`gh codespace ssh -c ${appSettings.codespaceName} "echo 'Waking up'"`);
        ctx.reply('✅ Codespace is awake and ready.');
    } catch {
        ctx.reply('❌ Failed to wake Codespace.');
    }
});

bot.action('cs_stop', async (ctx) => {
    ctx.answerCbQuery('Stopping...').catch(() => {});
    ctx.reply('⏳ Sending Stop signal to Codespace...');
    try {
        await execAsync(`gh codespace stop -c ${appSettings.codespaceName}`);
        ctx.reply('✅ Codespace is shutting down.');
    } catch {
        ctx.reply('❌ Failed to stop Codespace.');
    }
});

// ==========================================
// 3. REMOTE TERMINAL MODE
// ==========================================
bot.action('menu_terminal', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!appSettings.codespaceName) return ctx.answerCbQuery('⚠️ Configure a Codespace first!', { show_alert: true });
    
    ctx.session.state = 'AWAITING_TERMINAL_CMD';
    const menu = { reply_markup: { inline_keyboard: [[{ text: '🛑 Exit Terminal', callback_data: 'action_home', style: 'danger' }]] } };
    ctx.editMessageText(`🖥️ **Terminal Mode Active**\n\nTarget: \`${appSettings.codespaceName}\`\n\nSend any Linux command below to execute it on the Codespace.\n*(Tip: Send \`/exit\` to close terminal)*`, { parse_mode: 'Markdown', ...menu });
});

// ==========================================
// 4. TEXT HANDLER (ANTI-CRASH & TIMEOUTS)
// ==========================================
bot.on('text', async (ctx) => {
    try {
        const text = ctx.message.text.trim();
        const state = ctx.session.state;

        if (state === 'AWAITING_SUDO_ID') {
            const targetId = parseInt(text);
            if (isNaN(targetId)) return ctx.reply('❌ Invalid ID.');
            if (sudoUsers.includes(targetId)) {
                sudoUsers = sudoUsers.filter(id => id !== targetId);
                saveSudo();
                ctx.reply(`✅ Removed \`${targetId}\` from Sudo.`, { parse_mode: 'Markdown', ...getMainMenu() });
            } else {
                sudoUsers.push(targetId);
                saveSudo();
                ctx.reply(`✅ Added \`${targetId}\` to Sudo.`, { parse_mode: 'Markdown', ...getMainMenu() });
            }
            ctx.session.state = 'IDLE';
        } 
        else if (state === 'AWAITING_GITHUB_TOKEN') {
            const msg = await ctx.reply(`⏳ Authenticating with GitHub...`, { parse_mode: 'Markdown' });
            try {
                await execAsync(`echo "${text}" | gh auth login --with-token`);
                const { stdout } = await execAsync(`gh auth status`);
                
                ctx.session.state = 'IDLE';
                const cleanOutput = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').trim();
                
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ **GitHub Login Successful!**\n\n\`\`\`text\n${cleanOutput.substring(0, 300)}\n\`\`\`\nDon't forget to **☁️ Set Codespace** for the new account!`, { parse_mode: 'Markdown', ...getMainMenu() });
            } catch (error) {
                const errText = error.stderr ? error.stderr.substring(0, 300) : error.message;
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ **Authentication Failed:**\n\`\`\`text\n${errText}\n\`\`\`\nTry sending a valid token again:`, { parse_mode: 'Markdown' });
            }
        }
        else if (state === 'AWAITING_CODESPACE_NAME') {
            const msg = await ctx.reply(`⏳ Verifying connection to \`${text}\`...`, { parse_mode: 'Markdown' });
            try {
                await execAsync(`gh codespace view -c ${text}`);
                appSettings.codespaceName = text;
                saveSettings();
                ctx.session.state = 'IDLE';
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ **Target updated to:** \`${text}\``, { parse_mode: 'Markdown', ...getMainMenu() });
            } catch {
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ **Access Denied:** \`${text}\` not found.\nCheck name and try again:`, { parse_mode: 'Markdown' });
            }
        }
        else if (state === 'AWAITING_BOT_NAME') {
            if (!/^[a-zA-Z0-9_-]+$/.test(text)) return ctx.reply('❌ Invalid name. Try again:');
            ctx.session.botName = text;
            ctx.session.state = 'AWAITING_SESSION_ID';
            ctx.reply(`✅ Bot: **${text}**.\nEnter **SESSION ID**:`, { parse_mode: 'Markdown' });
        } 
        else if (state === 'AWAITING_SESSION_ID') {
            const sessionId = text;
            const botName = ctx.session.botName;
            ctx.session.state = 'IDLE';
            deployToCodespace(ctx, botName, sessionId); 
        }
        else if (state === 'AWAITING_TERMINAL_CMD') {
            if (text.toLowerCase() === '/exit') {
                ctx.session.state = 'IDLE';
                return ctx.reply('🛑 **Exited Terminal Mode.**', { parse_mode: 'Markdown', ...getMainMenu() });
            }
            const msg = await ctx.reply(`⏳ Executing: \`${text}\``, { parse_mode: 'Markdown' });
            try {
                const { stdout, stderr } = await execAsync(`gh codespace ssh -c ${appSettings.codespaceName} "${text}"`, { timeout: 15000 });
                const output = (stdout || stderr || 'Command executed with no output.').substring(0, 3900);
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `🖥️ **Terminal Output:**\n\`\`\`text\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
            } catch (error) {
                let errText = (error.stderr || error.message || 'Unknown error').substring(0, 3900);
                if (error.killed) {
                    errText = "⏱️ **Command timed out after 15 seconds!**\n\n⚠️ You cannot run interactive commands like `sudo su` or `nano` because they wait for live keyboard input.";
                }
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ **Command Error:**\n\`\`\`text\n${errText}\n\`\`\``, { parse_mode: 'Markdown' });
            }
        }
    } catch (e) { console.error('Text Handler Error:', e); }
});

// ==========================================
// 5. DEPLOYMENT & MANAGEMENT (LIVE LOGS)
// ==========================================
bot.action('menu_deploy', (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!appSettings.codespaceName) return ctx.answerCbQuery('⚠️ Configure a Codespace first!', { show_alert: true });
    ctx.session.state = 'AWAITING_BOT_NAME';
    ctx.reply('🚀 **Deployment Wizard**\nEnter a unique name for this bot (no spaces):');
});

async function deployToCodespace(ctx, botName, sessionId) {
    let msg = await ctx.reply(`📦 **Deploying ${botName}...**\n\`\`\`text\nConnecting to Codespace...\n\`\`\``, { parse_mode: 'Markdown' });
    
    const randomPort = Math.floor(Math.random() * 6000) + 3000;
    
    const remoteCommand = `command -v pm2 > /dev/null || npm install -g pm2; command -v yarn > /dev/null || (rm -rf $(npm root -g)/.yarn-* && npm install -g yarn); mkdir -p ~/deployed_bots && cd ~/deployed_bots && rm -rf ${botName} && git clone --depth 1 https://github.com/lyfe00011/levanter ${botName} && cd ${botName} && yarn install && echo "VPS=true" > config.env && echo "SESSION_ID=${sessionId}" >> config.env && echo "PREFIX=." >> config.env && echo "NAME=${botName}" >> config.env && echo "PORT=${randomPort}" >> config.env && pm2 start . --name ${botName} && pm2 save`;

    const deployProcess = exec(`gh codespace ssh -c ${appSettings.codespaceName} "${remoteCommand}"`);

    let outputLog = ["Initializing deployment process..."];
    let lastUpdate = 0;
    let updateTimer = null;

    const updateTelegramMessage = async () => {
        const now = Date.now();
        if (now - lastUpdate < 4000) {
            if (!updateTimer) {
                updateTimer = setTimeout(() => { updateTimer = null; updateTelegramMessage(); }, 4000 - (now - lastUpdate));
            }
            return;
        }
        lastUpdate = Date.now();
        
        const cleanLog = outputLog.slice(-12).map(line => line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')).join('\n');
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `📦 **Deploying ${botName}...**\n\`\`\`text\n${cleanLog}\n\`\`\``, { parse_mode: 'Markdown' });
        } catch (e) { /* Ignore rate limit errors */ }
    };

    deployProcess.stdout.on('data', (data) => {
        outputLog.push(...data.toString().split('\n').filter(Boolean));
        updateTelegramMessage();
    });

    deployProcess.stderr.on('data', (data) => {
        outputLog.push(...data.toString().split('\n').filter(Boolean));
        updateTelegramMessage();
    });

    deployProcess.on('close', async (code) => {
        if (code === 0) {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `🚀 **Success!**\n**${botName}** is online in the codespace.`, { parse_mode: 'Markdown' });
        } else {
            const errorLog = outputLog.slice(-15).map(line => line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')).join('\n');
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ **Deployment Failed (Code ${code}).**\n\`\`\`text\n${errorLog}\n\`\`\``, { parse_mode: 'Markdown' });
        }
    });
}

bot.action('menu_manage', async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    if (!appSettings.codespaceName) return ctx.reply('⚠️ Set Codespace first.');
    
    try {
        const { stdout } = await execAsync(`gh codespace ssh -c ${appSettings.codespaceName} "pm2 jlist"`);
        const processes = JSON.parse(stdout);
        if (processes.length === 0) {
            return ctx.editMessageText('No bots running.', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'action_home', style: 'primary' }]] } });
        }
        
        const buttons = processes.map(p => [{ 
            text: `${p.pm2_env.status === 'online' ? '🟢' : '🔴'} ${p.name}`, 
            callback_data: `bot_menu_${p.name}`,
            style: p.pm2_env.status === 'online' ? 'success' : 'danger' 
        }]);
        buttons.push([{ text: '⬅️ Main Menu', callback_data: 'action_home', style: 'primary' }]);
        
        ctx.editMessageText('📦 **Select a bot:**', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    } catch {
        ctx.reply('❌ Could not reach Codespace or parse PM2 list.');
    }
});

bot.action(/bot_menu_(.+)/, (ctx) => {
    const botName = ctx.match[1];
    ctx.answerCbQuery().catch(() => {});
    const menu = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🔄 Restart', callback_data: `pm2_restart_${botName}`, style: 'primary' }, 
                    { text: '🛑 Stop', callback_data: `pm2_stop_${botName}`, style: 'danger' }
                ],
                [
                    { text: '📜 Logs', callback_data: `pm2_logs_${botName}`, style: 'primary' }, 
                    { text: '🗑️ Delete', callback_data: `pm2_delete_${botName}`, style: 'danger' }
                ],
                [{ text: '⬅️ Back to List', callback_data: 'menu_manage', style: 'primary' }]
            ]
        }
    };
    ctx.editMessageText(`⚙️ **Managing:** \`${botName}\``, { parse_mode: 'Markdown', ...menu });
});

['restart', 'stop', 'delete'].forEach(action => {
    bot.action(new RegExp(`pm2_${action}_(.+)`), async (ctx) => {
        const botName = ctx.match[1];
        ctx.answerCbQuery(`Executing ${action}...`).catch(() => {});
        let command = `pm2 ${action} ${botName} && pm2 save`;
        if (action === 'delete') command += ` && rm -rf ~/deployed_bots/${botName}`;
        
        try {
            await execAsync(`gh codespace ssh -c ${appSettings.codespaceName} "${command}"`);
            ctx.reply(`✅ Executed **${action}** on \`${botName}\`.`, { parse_mode: 'Markdown' });
        } catch {
            ctx.reply(`❌ Failed to ${action} ${botName}.`);
        }
    });
});

bot.action(/pm2_logs_(.+)/, async (ctx) => {
    const botName = ctx.match[1];
    ctx.answerCbQuery().catch(() => {});
    try {
        const { stdout } = await execAsync(`gh codespace ssh -c ${appSettings.codespaceName} "pm2 logs ${botName} --lines 30 --nostream"`);
        const cleanLogs = stdout.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        ctx.reply(`📊 **Logs for ${botName}:**\n\`\`\`text\n${cleanLogs.trim()}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (error) {
        ctx.reply(`❌ Failed to fetch logs.`);
    }
});

bot.launch().then(() => console.log('✅ VPS Middleware Online.')).catch(err => console.error('Launch failed:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
