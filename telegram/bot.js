const path = require('path');
const fs = require('fs');
const UserService = require('../services/userService');
const WalletService = require('../services/walletService');
const Game = require('../models/Game');

function startTelegramBot({ BOT_TOKEN, WEBAPP_URL }) {
    try {
        const { Telegraf } = require('telegraf');
        if (!BOT_TOKEN) {
            console.warn('⚠️ BOT_TOKEN not set. Telegram bot is disabled. Create a .env with BOT_TOKEN=...');
            return;
        }

        const bot = new Telegraf(BOT_TOKEN);
        const isHttpsWebApp = typeof WEBAPP_URL === 'string' && WEBAPP_URL.startsWith('https://');

        (async () => {
            try {
                await bot.telegram.setMyCommands([
                    { command: 'start', description: 'Start' },
                    { command: 'register', description: 'Register' },
                    { command: 'play', description: 'Play' },
                    { command: 'deposit', description: 'Deposit' },
                    { command: 'balance', description: 'Balance' },
                    { command: 'support', description: 'Contact Support' },
                    { command: 'instruction', description: 'How to Play' }
                ]);

                if (isHttpsWebApp) {
                    await bot.telegram.setChatMenuButton({
                        menu_button: { type: 'web_app', text: 'Play', web_app: { url: WEBAPP_URL } }
                    });
                } else {
                    await bot.telegram.setChatMenuButton({ menu_button: { type: 'commands' } });
                }

                // Per-chat admin command setup is skipped; admins are DB-based and commands shown globally.
            } catch (e) {
                console.log('Failed to set commands/menu:', e?.message || e);
            }
        })();

        function parseReceipt(text) {
            if (typeof text !== 'string') return null;
            const patterns = [/ETB\s*([0-9]+(?:\.[0-9]{1,2})?)/i, /(\d+(?:\.\d{1,2})?)\s*ETB/i, /(\d+(?:\.\d{1,2})?)\s*ብር/i, /(\d+(?:\.\d{1,2})?)/i];
            let amount = null;
            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match) {
                    amount = Number(match[1]);
                    if (amount >= 50) break;
                }
            }
            if (!amount || amount < 50) return null;
            const whenMatch = text.match(/on\s+([0-9]{2}\/[0-9]{2}\/[0-9]{4})\s+at\s+([0-9]{2}:[0-9]{2}:[0-9]{2})/i);
            const refMatch = text.match(/id=([A-Z0-9]+)/i) || text.match(/ref[:\s]*([A-Z0-9]+)/i);
            return { amount, when: whenMatch ? `${whenMatch[1]} ${whenMatch[2]}` : null, ref: refMatch ? refMatch[1] : null, type: text.toLowerCase().includes('telebirr') ? 'telebirr' : text.toLowerCase().includes('commercial') ? 'commercial' : text.toLowerCase().includes('abyssinia') ? 'abyssinia' : text.toLowerCase().includes('cbe') ? 'cbe' : 'unknown' };
        }

        async function isAdminByDB(telegramId) {
            try {
                const user = await require('../models/User').findOne({ telegramId: String(telegramId) }, { role: 1 });
                return !!(user && user.role === 'admin');
            } catch { return false; }
        }

        bot.start(async (ctx) => {
            try { await UserService.createOrUpdateUser(ctx.from); } catch { }
            const isAdmin = await isAdminByDB(ctx.from.id);
            if (isAdmin) {
                const adminText = '🛠️ Admin Panel';
                const keyboard = { reply_markup: { inline_keyboard: [[{ text: '📈 Today Revenue (20%)', callback_data: 'admin_today_revenue' }], [{ text: '📊 This Week Revenue (20%)', callback_data: 'admin_week_revenue' }], [{ text: '📣 Broadcast', callback_data: 'admin_broadcast' }]] } };
                const photoPath = path.join(__dirname, '..', 'static', 'lb.png');
                const photo = fs.existsSync(photoPath) ? { source: fs.createReadStream(photoPath) } : (WEBAPP_URL || '').replace(/\/$/, '') + '/lb.png';
                return ctx.replyWithPhoto(photo, { caption: adminText, reply_markup: keyboard.reply_markup });
            }
            try {
                let registered = false;
                const user = await UserService.getUserByTelegramId(String(ctx.from.id));
                registered = !!(user && (user.isRegistered || user.phone));
                if (!registered) {
                    const regKeyboard = { reply_markup: { keyboard: [[{ text: '📱 Share Contact', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } };
                    const regText = '📝 Please complete registration to continue.\n\n📱 Tap "Share Contact" below to provide your phone number.';
                    return ctx.reply(regText, regKeyboard);
                }
                const welcomeText = `👋 Welcome to Love Bingo! Choose an Option below.`;
                const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🎮 Play', callback_data: 'play' }, { text: '📝 Register', callback_data: 'register' }], [{ text: '💵 Check Balance', callback_data: 'balance' }, { text: '💰 Deposit', callback_data: 'deposit' }], [{ text: '☎️ Contact Support', callback_data: 'support' }, { text: '📖 Instruction', callback_data: 'instruction' }], [{ text: '🎁 Transfer', callback_data: 'transfer' }, { text: '🤑 Withdraw', callback_data: 'withdraw' }], [{ text: '🔗 Invite', callback_data: 'invite' }]] } };
                const photoPath = path.join(__dirname, '..', 'static', 'lb.png');
                const photo = fs.existsSync(photoPath) ? { source: fs.createReadStream(photoPath) } : (WEBAPP_URL || '').replace(/\/$/, '') + '/lb.png';
                return ctx.replyWithPhoto(photo, { caption: welcomeText, reply_markup: keyboard.reply_markup });
            } catch {
                return ctx.reply('❌ Database unavailable. Please try again later.');
            }
        });

        async function ensureAdmin(ctx) {
            const isAdmin = await isAdminByDB(ctx.from?.id);
            if (!isAdmin) { await ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => { }); return false; }
            return true;
        }

        bot.command('admin', async (ctx) => {
            if (!(await isAdminByDB(ctx.from.id))) { return ctx.reply('Unauthorized'); }
            const adminText = '🛠️ Admin Panel';
            const keyboard = { reply_markup: { inline_keyboard: [[{ text: '📈 Today Revenue (20%)', callback_data: 'admin_today_revenue' }], [{ text: '📊 This Week Revenue (20%)', callback_data: 'admin_week_revenue' }], [{ text: '📣 Broadcast', callback_data: 'admin_broadcast' }]] } };
            return ctx.reply(adminText, keyboard);
        });

        // One-time bootstrap: promote caller to admin with secret code
        const mongoose = require('mongoose');
        function isDbReady() {
            return mongoose.connection && mongoose.connection.readyState === 1;
        }
        bot.command('admin_boot', async (ctx) => {
            const parts = (ctx.message.text || '').trim().split(/\s+/);
            const code = parts[1] || '';
            const expected = process.env.ADMIN_BOOT_CODE || '';
            if (!expected) return ctx.reply('Boot code not configured.');
            if (code !== expected) return ctx.reply('Invalid code.');
            if (!isDbReady()) return ctx.reply('Database is not connected yet. Please try again in a moment.');
            try {
                const User = require('../models/User');
                const telegramId = String(ctx.from.id);
                const user = await User.findOneAndUpdate(
                    { telegramId },
                    {
                        $set: { role: 'admin' },
                        $setOnInsert: {
                            telegramId,
                            firstName: ctx.from.first_name || 'Unknown',
                            lastName: ctx.from.last_name || '',
                            username: ctx.from.username || ''
                        }
                    },
                    { new: true, upsert: true }
                );
                if (user) return ctx.reply('✅ You are now an admin. Use /admin');
                return ctx.reply('User not found. Start the bot first.');
            } catch (e) {
                console.error('admin_boot error:', e?.message || e);
                return ctx.reply('Failed to promote.');
            }
        });

        // Admin role management
        bot.command('promote', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            const parts = (ctx.message.text || '').trim().split(/\s+/);
            const targetId = parts[1];
            if (!targetId) return ctx.reply('Usage: /promote <telegramId>');
            try {
                const User = require('../models/User');
                const user = await User.findOneAndUpdate({ telegramId: String(targetId) }, { $set: { role: 'admin' } }, { new: true });
                if (!user) return ctx.reply('User not found.');
                return ctx.reply(`✅ Promoted ${targetId} to admin.`);
            } catch { return ctx.reply('Failed to promote.'); }
        });

        bot.command('demote', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            const parts = (ctx.message.text || '').trim().split(/\s+/);
            const targetId = parts[1];
            if (!targetId) return ctx.reply('Usage: /demote <telegramId>');
            try {
                const User = require('../models/User');
                const user = await User.findOneAndUpdate({ telegramId: String(targetId) }, { $set: { role: 'user' } }, { new: true });
                if (!user) return ctx.reply('User not found.');
                return ctx.reply(`✅ Demoted ${targetId} to user.`);
            } catch { return ctx.reply('Failed to demote.'); }
        });

        bot.action('admin_today_revenue', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            try {
                const start = new Date(); start.setHours(0, 0, 0, 0);
                const end = new Date(); end.setHours(23, 59, 59, 999);
                let todayRevenue = 0;
                try {
                    const games = await Game.find({ status: 'finished', finishedAt: { $gte: start, $lte: end } }, { systemCut: 1 });
                    todayRevenue = games.reduce((sum, g) => sum + (g.systemCut || 0), 0);
                } catch (e) { todayRevenue = 0; }
                await ctx.answerCbQuery('');
                await ctx.reply(`📈 Today System Revenue (20% per game): ETB ${todayRevenue.toFixed(2)}`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
            } catch { await ctx.reply('❌ Failed to fetch today revenue'); }
        });

        bot.action('back_to_admin', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            const adminText = '🛠️ Admin Panel';
            const keyboard = { reply_markup: { inline_keyboard: [[{ text: '📈 Today Revenue (20%)', callback_data: 'admin_today_revenue' }], [{ text: '📊 This Week Revenue (20%)', callback_data: 'admin_week_revenue' }], [{ text: '📣 Broadcast', callback_data: 'admin_broadcast' }]] } };
            await ctx.editMessageText(adminText, keyboard).catch(() => ctx.reply(adminText, keyboard));
        });

        bot.action('admin_week_revenue', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            try {
                const now = new Date();
                const day = now.getDay();
                const diffToMonday = (day === 0 ? -6 : 1 - day);
                const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() + diffToMonday);
                const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6); sunday.setHours(23, 59, 59, 999);
                let weekRevenue = 0;
                try { const games = await Game.find({ status: 'finished', finishedAt: { $gte: monday, $lte: sunday } }, { systemCut: 1 }); weekRevenue = games.reduce((s, g) => s + (g.systemCut || 0), 0); } catch { weekRevenue = 0; }
                await ctx.answerCbQuery('');
                await ctx.reply(`📊 This Week System Revenue (20% per game): ETB ${weekRevenue.toFixed(2)}`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
            } catch { await ctx.reply('❌ Failed to fetch weekly revenue'); }
        });

        const adminStates = new Map();
        async function getBroadcastTargets() {
            const dbUsers = await require('../models/User').find({}, { telegramId: 1 });
            const ids = (dbUsers || []).map(u => String(u.telegramId)).filter(Boolean);
            if (!ids.length) { throw new Error('NO_RECIPIENTS'); }
            return Array.from(new Set(ids));
        }
        async function sendToAll(ids, sendOne) {
            const results = await Promise.allSettled(ids.map(id => sendOne(id)));
            const success = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - success;
            return { success, failed, total: results.length };
        }
        function buildBroadcastMarkup(caption) {
            const kb = { inline_keyboard: [] };
            if (isHttpsWebApp) { kb.inline_keyboard.push([{ text: 'Play', web_app: { url: WEBAPP_URL } }]); }
            const base = kb.inline_keyboard.length ? { reply_markup: kb } : {};
            if (caption !== undefined) return { ...base, caption, parse_mode: 'HTML' };
            return { ...base, parse_mode: 'HTML' };
        }
        async function sendPendingMediaToAll(pending, caption) {
            const targets = await getBroadcastTargets();
            const options = buildBroadcastMarkup(caption);
            if (pending.kind === 'photo') return sendToAll(targets, async (id) => bot.telegram.sendPhoto(id, pending.fileId, options));
            if (pending.kind === 'video') return sendToAll(targets, async (id) => bot.telegram.sendVideo(id, pending.fileId, options));
            if (pending.kind === 'document') return sendToAll(targets, async (id) => bot.telegram.sendDocument(id, pending.fileId, options));
            if (pending.kind === 'animation') return sendToAll(targets, async (id) => bot.telegram.sendAnimation(id, pending.fileId, options));
            throw new Error('UNSUPPORTED_MEDIA');
        }

        bot.action('admin_broadcast', async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            adminStates.set(String(ctx.from.id), { mode: 'broadcast' });
            await ctx.answerCbQuery('');
            await ctx.reply('📣 Send the message to broadcast now (text, photo, video, document, etc.).', { reply_markup: { inline_keyboard: [[{ text: '🔙 Cancel', callback_data: 'back_to_admin' }]] } });
        });

        async function isUserRegistered(userId) {
            const user = await UserService.getUserByTelegramId(userId);
            return !!(user && (user.isRegistered || user.phone));
        }
        async function requireRegistration(ctx) {
            const userId = String(ctx.from.id);
            const ok = await isUserRegistered(userId);
            if (ok) return true;
            try { await ctx.answerCbQuery('Registration required'); } catch { }
            const keyboard = { reply_markup: { keyboard: [[{ text: '📱 Share Contact', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } };
            await ctx.reply('📝 Please complete registration to continue.\n\n📱 Tap "Share Contact" below to provide your phone number.', keyboard);
            return false;
        }

        bot.action('play', async (ctx) => {
            if (!(await requireRegistration(ctx))) return;
            ctx.answerCbQuery('🎮 Opening game...');
            const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
            if (isHttpsWebApp) { keyboard.inline_keyboard.unshift([{ text: '🌐 Open Web App', web_app: { url: WEBAPP_URL } }]); }
            const note = isHttpsWebApp ? '' : '\n\n⚠️ Web App button hidden because Telegram requires HTTPS. Set WEBAPP_URL in .env to an https URL.';
            ctx.reply('🎮 To play Bingo, please use our web app:' + note, { reply_markup: keyboard });
        });

        bot.action('register', async (ctx) => {
            ctx.answerCbQuery('📝 Registration info...');
            const userId = String(ctx.from.id);
            const already = await isUserRegistered(userId);
            if (already) {
                const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
                return ctx.reply('✅ You are already registered. Thank you!', { reply_markup: keyboard });
            }
            const keyboard = { reply_markup: { keyboard: [[{ text: '📱 Share Contact', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } };
            ctx.reply('📝 To complete registration, please share your contact information:\n\n📱 Click "Share Contact" below to provide your phone number.\n\n✅ This helps us verify your account and provide better support.', keyboard);
        });

        bot.action('balance', async (ctx) => {
            if (!(await requireRegistration(ctx))) return;
            try {
                const userId = String(ctx.from.id);
                const userData = await UserService.getUserWithWallet(userId);
                if (!userData || !userData.wallet) { return ctx.reply('❌ Wallet not found. Please register first.'); }
                const w = userData.wallet;
                ctx.answerCbQuery('💵 Balance checked');
                const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
                if (isHttpsWebApp) keyboard.inline_keyboard.unshift([{ text: '🌐 Open Web App', web_app: { url: WEBAPP_URL } }]);
                ctx.reply(`💵 Your Wallet Balance:\n\n💰 Main Wallet: ETB ${w.main.toFixed(2)}\n🎮 Play Balance: ETB ${w.play.toFixed(2)}\n🪙 Coins: ${w.coins.toFixed(0)}`, { reply_markup: keyboard });
            } catch (error) {
                console.error('Balance check error:', error);
                ctx.reply('❌ Error checking balance. Please try again.');
            }
        });

        bot.action('deposit', async (ctx) => {
            if (!(await requireRegistration(ctx))) return;
            ctx.answerCbQuery('💰 Deposit amount...');
            ctx.reply('💰 Enter the amount you want to deposit, starting from 50 Birr.');
        });

        bot.action('support', (ctx) => {
            ctx.answerCbQuery('☎️ Support info...');
            ctx.reply('☎️ Contact Support:\n\n📞 For payment issues:\n@beteseb3\n@betesebbingosupport2\n\n💬 For general support:\n@betesebsupport\n\n⏰ Support hours:\n24/7 available', { reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] } });
        });

        bot.action('instruction', (ctx) => {
            ctx.answerCbQuery('📖 Instructions...');
            const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
            if (isHttpsWebApp) keyboard.inline_keyboard.unshift([{ text: '🎮 Start Playing', web_app: { url: WEBAPP_URL } }]);
            ctx.reply('📖 How to Play Love Bingo:\n\n1️⃣ Choose your stake (ETB 10 or 50)\n2️⃣ Select a bingo card\n3️⃣ Wait for numbers to be called\n4️⃣ Mark numbers on your card\n5️⃣ Call "BINGO!" when you win\n\n🎯 Win by getting 5 in a row (horizontal, vertical, or diagonal)\n\n💰 Prizes are shared among all winners!', { reply_markup: keyboard });
        });

        bot.action('transfer', async (ctx) => {
            if (!(await requireRegistration(ctx))) return;
            ctx.answerCbQuery('🎁 Transfer info...');
            ctx.reply('🎁 Transfer to Friends:\n\n💡 Transfer feature coming soon!\n\n🔮 You\'ll be able to:\n• Send play balance to friends\n• Gift coins to other players\n• Share winnings\n\n📱 Stay tuned for updates!', { reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] } });
        });

        bot.action('withdraw', async (ctx) => {
            if (!(await requireRegistration(ctx))) return;
            ctx.answerCbQuery('🤑 Withdraw info...');

            try {
                const userId = String(ctx.from.id);
                const userData = await UserService.getUserWithWallet(userId);
                if (!userData || !userData.wallet) {
                    return ctx.reply('❌ Wallet not found. Please register first.');
                }

                const w = userData.wallet;
                const keyboard = { inline_keyboard: [] };

                if (w.main >= 50) {
                    keyboard.inline_keyboard.push([{ text: '💰 Request Withdrawal', callback_data: 'request_withdrawal' }]);
                } else {
                    keyboard.inline_keyboard.push([{ text: '❌ Insufficient Balance (Min: 50 ETB)', callback_data: 'back_to_menu' }]);
                }

                keyboard.inline_keyboard.push([{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]);

                ctx.reply(`🤑 Withdraw Funds:\n\n💰 Main Wallet: ETB ${w.main.toFixed(2)}\n\n💡 Withdrawal Options:\n• Minimum: ETB 50\n• Maximum: ETB 10,000\n• Processing: 24-48 hours\n\n📞 Contact support for assistance`, { reply_markup: keyboard });
            } catch (error) {
                console.error('Withdraw info error:', error);
                ctx.reply('❌ Error checking balance. Please try again.');
            }
        });

        bot.action('request_withdrawal', async (ctx) => {
            if (!(await requireRegistration(ctx))) return;
            ctx.answerCbQuery('💰 Withdrawal request...');
            withdrawalStates.set(String(ctx.from.id), 'awaiting_amount');
            ctx.reply('💰 Enter withdrawal amount (ETB 50 - 10,000):\n\n💡 Example: 100\n\n📱 You will be asked for destination details after amount confirmation.');
        });

        // Admin withdrawal approval/denial handlers
        bot.action(/^approve_wd_(.+)$/, async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            const withdrawalId = ctx.match[1];

            try {
                const apiBase = process.env.API_URL || 'http://localhost:3001';
                const response = await fetch(`${apiBase}/admin/withdrawals/${withdrawalId}/approve`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (response.ok) {
                    await ctx.answerCbQuery('✅ Withdrawal approved');
                    await ctx.reply('✅ Withdrawal has been approved and processed.');
                } else {
                    await ctx.answerCbQuery('❌ Failed to approve');
                    await ctx.reply('❌ Failed to approve withdrawal. Please try again.');
                }
            } catch (error) {
                console.error('Approval error:', error);
                await ctx.answerCbQuery('❌ Error occurred');
                await ctx.reply('❌ Error processing approval. Please try again.');
            }
        });

        bot.action(/^deny_wd_(.+)$/, async (ctx) => {
            if (!(await ensureAdmin(ctx))) return;
            const withdrawalId = ctx.match[1];

            try {
                const apiBase = process.env.API_URL || 'http://localhost:3001';
                const response = await fetch(`${apiBase}/admin/withdrawals/${withdrawalId}/deny`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (response.ok) {
                    await ctx.answerCbQuery('❌ Withdrawal denied');
                    await ctx.reply('❌ Withdrawal has been denied.');
                } else {
                    await ctx.answerCbQuery('❌ Failed to deny');
                    await ctx.reply('❌ Failed to deny withdrawal. Please try again.');
                }
            } catch (error) {
                console.error('Denial error:', error);
                await ctx.answerCbQuery('❌ Error occurred');
                await ctx.reply('❌ Error processing denial. Please try again.');
            }
        });

        bot.action('invite', async (ctx) => {
            if (!(await requireRegistration(ctx))) return;
            ctx.answerCbQuery('🔗 Invite friends...');
            const inviteLink = `https://t.me/${ctx.botInfo.username}?start=invite_${ctx.from.id}`;
            const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
            keyboard.inline_keyboard.unshift([{ text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=Join me in Love Bingo!` }]);
            ctx.reply(`🔗 Invite Friends to Love Bingo!\n\n👥 Share this link with your friends:\n\n${inviteLink}\n\n🎁 Invite rewards coming soon!\n\n💡 The more friends you invite, the more rewards you'll get!`, { reply_markup: keyboard });
        });

        bot.action('back_to_menu', async (ctx) => {
            if (!(await requireRegistration(ctx))) return;
            ctx.answerCbQuery('🔙 Back to menu');
            const welcomeText = `👋 Welcome to Love Bingo! Choose an Option below.`;
            const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🎮 Play', callback_data: 'play' }, { text: '📝 Register', callback_data: 'register' }], [{ text: '💵 Check Balance', callback_data: 'balance' }, { text: '💰 Deposit', callback_data: 'deposit' }], [{ text: '☎️ Contact Support', callback_data: 'support' }, { text: '📖 Instruction', callback_data: 'instruction' }], [{ text: '🎁 Transfer', callback_data: 'transfer' }, { text: '🤑 Withdraw', callback_data: 'withdraw' }], [{ text: '🔗 Invite', callback_data: 'invite' }]] } };
            return ctx.editMessageText(welcomeText, keyboard);
        });

        bot.action(/^deposit_telebirr_(\d+(?:\.\d{1,2})?)$/, (ctx) => {
            const amount = ctx.match[1];
            ctx.answerCbQuery('📱 Telebirr deposit...');
            ctx.reply(`📱 Telebirr Deposit Instructions:\n\n📋 Agent Details:\n👤 Name: TADESSE\n📱 Telebirr: 0912345678\n\n💡 Steps:\n1️⃣ Open your Telebirr app\n2️⃣ Select "Send Money"\n3️⃣ Enter agent number: 0912345678\n4️⃣ Enter amount: ETB ${amount}\n5️⃣ Send the transaction\n6️⃣ Paste the receipt here\n\n✅ Your wallet will be credited automatically!`, { reply_markup: { inline_keyboard: [[{ text: '📱 Send Receipt', callback_data: 'send_receipt_telebirr' }], [{ text: '🔙 Back to Deposit', callback_data: 'deposit' }]] } });
        });
        bot.action(/^deposit_commercial_(\d+(?:\.\d{1,2})?)$/, (ctx) => {
            const amount = ctx.match[1];
            ctx.answerCbQuery('🏦 Commercial Bank deposit...');
            ctx.reply(`🏦 Commercial Bank Deposit Instructions:\n\n📋 Agent Details:\n👤 Name: TADESSE\n🏦 Account: 1000071603052\n🏛️ Bank: Commercial Bank of Ethiopia\n\n💡 Steps:\n1️⃣ Go to Commercial Bank\n2️⃣ Transfer to account: 1000071603052\n3️⃣ Enter amount: ETB ${amount}\n4️⃣ Complete the transaction\n5️⃣ Send the SMS receipt here\n\n✅ Your wallet will be credited automatically!`, { reply_markup: { inline_keyboard: [[{ text: '📱 Send SMS Receipt', callback_data: 'send_receipt_commercial' }], [{ text: '🔙 Back to Deposit', callback_data: 'deposit' }]] } });
        });
        bot.action(/^deposit_abyssinia_(\d+(?:\.\d{1,2})?)$/, (ctx) => {
            const amount = ctx.match[1];
            ctx.answerCbQuery('🏛️ Abyssinia Bank deposit...');
            ctx.reply(`🏛️ Abyssinia Bank Deposit Instructions:\n\n📋 Agent Details:\n👤 Name: TADESSE\n🏦 Account: 2000081603052\n🏛️ Bank: Abyssinia Bank\n\n💡 Steps:\n1️⃣ Go to Abyssinia Bank\n2️⃣ Transfer to account: 2000081603052\n3️⃣ Enter amount: ETB ${amount}\n4️⃣ Complete the transaction\n5️⃣ Send the SMS receipt here\n\n✅ Your wallet will be credited automatically!`, { reply_markup: { inline_keyboard: [[{ text: '📱 Send SMS Receipt', callback_data: 'send_receipt_abyssinia' }], [{ text: '🔙 Back to Deposit', callback_data: 'deposit' }]] } });
        });
        bot.action(/^deposit_cbe_(\d+(?:\.\d{1,2})?)$/, (ctx) => {
            const amount = ctx.match[1];
            ctx.answerCbQuery('💳 CBE Birr deposit...');
            ctx.reply(`💳 CBE Birr Deposit Instructions:\n\n📋 Agent Details:\n👤 Name: TADESSE\n💳 CBE Birr: 0912345678\n🏦 Bank: Commercial Bank of Ethiopia\n\n💡 Steps:\n1️⃣ Open CBE Birr app\n2️⃣ Select "Send Money"\n3️⃣ Enter agent number: 0912345678\n4️⃣ Enter amount: ETB ${amount}\n5️⃣ Send the transaction\n6️⃣ Paste the receipt here\n\n✅ Your wallet will be credited automatically!`, { reply_markup: { inline_keyboard: [[{ text: '📱 Send Receipt', callback_data: 'send_receipt_cbe' }], [{ text: '🔙 Back to Deposit', callback_data: 'deposit' }]] } });
        });

        bot.action('send_receipt_telebirr', (ctx) => { ctx.answerCbQuery('📱 Ready for Telebirr receipt...'); ctx.reply('📱 Send your Telebirr transaction receipt here:\n\n💡 Just paste the full receipt message you received from Telebirr.\n\n✅ Your wallet will be credited automatically!'); });
        bot.action('send_receipt_commercial', (ctx) => { ctx.answerCbQuery('📱 Ready for Commercial Bank SMS...'); ctx.reply('📱 Send your Commercial Bank SMS receipt here:\n\n💡 Just paste the full SMS message you received from the bank.\n\n✅ Your wallet will be credited automatically!'); });
        bot.action('send_receipt_abyssinia', (ctx) => { ctx.answerCbQuery('📱 Ready for Abyssinia Bank SMS...'); ctx.reply('📱 Send your Abyssinia Bank SMS receipt here:\n\n💡 Just paste the full SMS message you received from the bank.\n\n✅ Your wallet will be credited automatically!'); });
        bot.action('send_receipt_cbe', (ctx) => { ctx.answerCbQuery('📱 Ready for CBE Birr receipt...'); ctx.reply('📱 Send your CBE Birr transaction receipt here:\n\n💡 Just paste the full receipt message you received from CBE Birr.\n\n✅ Your wallet will be credited automatically!'); });

        bot.on('contact', async (ctx) => {
            try {
                const userId = String(ctx.from.id);
                const contact = ctx.message.contact;
                try {
                    const existing = await UserService.getUserByTelegramId(userId);
                    if (existing && (existing.isRegistered || existing.phone)) {
                        await ctx.reply('✅ You are already registered with this account.');
                        await ctx.reply('🎮 You can now continue using the menu.', { reply_markup: { remove_keyboard: true } });
                        const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🎮 Play', callback_data: 'play' }, { text: '📝 Register', callback_data: 'register' }], [{ text: '💵 Check Balance', callback_data: 'balance' }, { text: '💰 Deposit', callback_data: 'deposit' }], [{ text: '☎️ Contact Support', callback_data: 'support' }, { text: '📖 Instruction', callback_data: 'instruction' }], [{ text: '🎁 Transfer', callback_data: 'transfer' }, { text: '🤑 Withdraw', callback_data: 'withdraw' }], [{ text: '🔗 Invite', callback_data: 'invite' }]] } };
                        setTimeout(() => { ctx.reply('🎮 Choose an option:', keyboard); }, 800);
                        return;
                    }
                } catch {
                    // ignore
                }
                try {
                    let user = await UserService.getUserByTelegramId(userId);
                    if (!user) { user = await UserService.createOrUpdateUser(ctx.from); }
                    await UserService.updateUserPhone(userId, contact.phone_number);
                } catch (dbError) {
                    console.log('Database unavailable during contact update');
                }
                ctx.reply('✅ Registration completed!\n\n📱 Phone: ' + contact.phone_number + '\n👤 Name: ' + (contact.first_name || '') + ' ' + (contact.last_name || '') + '\n\n🎮 You can now start playing!', { reply_markup: { remove_keyboard: true } });
            } catch (error) {
                console.error('Contact registration error:', error);
                ctx.reply('❌ Registration failed. Please try again.');
            }
            const keyboard = { reply_markup: { inline_keyboard: [[{ text: '🎮 Play', callback_data: 'play' }, { text: '📝 Register', callback_data: 'register' }], [{ text: '💵 Check Balance', callback_data: 'balance' }, { text: '💰 Deposit', callback_data: 'deposit' }], [{ text: '☎️ Contact Support', callback_data: 'support' }, { text: '📖 Instruction', callback_data: 'instruction' }], [{ text: '🎁 Transfer', callback_data: 'transfer' }, { text: '🤑 Withdraw', callback_data: 'withdraw' }], [{ text: '🔗 Invite', callback_data: 'invite' }]] } };
            setTimeout(() => { ctx.reply('🎮 Choose an option:', keyboard); }, 1000);
        });

        bot.on('text', async (ctx, next) => {
            try {
                const adminId = String(ctx.from.id);
                const state = adminStates.get(adminId);
                const isAdmin = await isAdminByDB(adminId);
                if (state && state.mode === 'await_caption_media' && isAdmin) {
                    adminStates.delete(adminId);
                    try {
                        const result = await sendPendingMediaToAll(state.pending, ctx.message.text || '');
                        const { success, failed, total } = result;
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    } catch {
                        await ctx.reply('❌ Failed to broadcast.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                    return;
                }
            } catch { }
            return next();
        });

        // Track withdrawal states
        const withdrawalStates = new Map();

        bot.hears(/.*/, async (ctx) => {
            try {
                if (ctx.message.text.startsWith('/') || ctx.update.callback_query) return;
                const isAdminMsg = await isAdminByDB(ctx.from.id);
                if (!isAdminMsg) {
                    const ok = await isUserRegistered(String(ctx.from.id));
                    if (!ok) {
                        const keyboard = { reply_markup: { keyboard: [[{ text: '📱 Share Contact', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } };
                        await ctx.reply('📝 Please complete registration to continue.\n\n📱 Tap "Share Contact" below to provide your phone number.', keyboard);
                        return;
                    }
                }
                const userId = String(ctx.from.id);
                const messageText = ctx.message.text || '';

                // Check if user is in withdrawal flow
                const withdrawalState = withdrawalStates.get(userId);
                if (withdrawalState === 'awaiting_amount') {
                    const amountMatch = messageText.match(/^(\d+(?:\.\d{1,2})?)$/);
                    if (amountMatch) {
                        const amount = Number(amountMatch[1]);
                        if (amount >= 50 && amount <= 10000) {
                            // Store amount and ask for destination
                            withdrawalStates.set(userId, { stage: 'awaiting_destination', amount });
                            ctx.reply(`💰 Withdrawal Amount: ETB ${amount}\n\n📱 Please provide destination details:\n\n• Bank name\n• Account number\n• Account holder name\n\n💡 Example: "CBE Bank, 1000123456789, John Doe"`);
                            return;
                        } else {
                            ctx.reply('❌ Invalid amount. Please enter between ETB 50 - 10,000.');
                            return;
                        }
                    } else {
                        ctx.reply('❌ Please enter a valid amount (numbers only).');
                        return;
                    }
                }

                if (withdrawalState && withdrawalState.stage === 'awaiting_destination') {
                    const destination = messageText.trim();
                    if (destination.length < 10) {
                        ctx.reply('❌ Please provide complete destination details (at least 10 characters).');
                        return;
                    }

                    try {
                        // Create withdrawal request via API
                        const apiBase = process.env.API_URL || 'http://localhost:3001';
                        const response = await fetch(`${apiBase}/wallet/withdraw`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                amount: withdrawalState.amount,
                                destination
                            })
                        });

                        if (response.ok) {
                            const result = await response.json();
                            withdrawalStates.delete(userId);

                            // Notify admin
                            const adminUsers = await require('../models/User').find({ role: 'admin' }, { telegramId: 1 });
                            for (const admin of adminUsers) {
                                try {
                                    await bot.telegram.sendMessage(admin.telegramId,
                                        `🆕 New Withdrawal Request\n\n👤 User: ${ctx.from.first_name} ${ctx.from.last_name || ''}\n📱 Phone: ${ctx.from.id}\n💰 Amount: ETB ${withdrawalState.amount}\n🏦 Destination: ${destination}\n📋 Reference: ${result.reference}\n\n⏰ Process within 24-48 hours`,
                                        { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_wd_${result.withdrawalId}` }, { text: '❌ Deny', callback_data: `deny_wd_${result.withdrawalId}` }]] } }
                                    );
                                } catch (e) { console.log('Failed to notify admin:', e?.message); }
                            }

                            ctx.reply(`✅ Withdrawal Request Submitted!\n\n💰 Amount: ETB ${withdrawalState.amount}\n🏦 Destination: ${destination}\n📋 Reference: ${result.reference}\n\n⏰ Processing: 24-48 hours\n📞 Contact support for updates`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] } });
                        } else {
                            const error = await response.json();
                            let errorMsg = '❌ Withdrawal request failed.';
                            if (error.error === 'INSUFFICIENT_BALANCE') errorMsg = '❌ Insufficient balance in main wallet.';
                            else if (error.error === 'MINIMUM_WITHDRAWAL_50') errorMsg = '❌ Minimum withdrawal is ETB 50.';
                            else if (error.error === 'MAXIMUM_WITHDRAWAL_10000') errorMsg = '❌ Maximum withdrawal is ETB 10,000.';

                            ctx.reply(errorMsg, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] } });
                        }
                    } catch (error) {
                        console.error('Withdrawal API error:', error);
                        ctx.reply('❌ Withdrawal request failed. Please try again or contact support.');
                    }
                    withdrawalStates.delete(userId);
                    return;
                }

                const amountMatch = messageText.match(/^(\d+(?:\.\d{1,2})?)$/);
                if (amountMatch) {
                    const amount = Number(amountMatch[1]);
                    if (amount >= 50) {
                        ctx.reply('💡 You can only deposit money using the options below.\n\n📋 Transfer Methods:\n1️⃣ From Telebirr to Agent Telebirr only\n2️⃣ From Commercial Bank to Agent Commercial Bank only\n3️⃣ From Abyssinia Bank to Agent Abyssinia Bank only\n4️⃣ From CBE Birr to Agent CBE Birr only\n\n🏦 Choose your preferred payment option:', { reply_markup: { inline_keyboard: [[{ text: '📱 Telebirr', callback_data: `deposit_telebirr_${amount}` }], [{ text: '🏦 Commercial Bank', callback_data: `deposit_commercial_${amount}` }], [{ text: '🏛️ Abyssinia Bank', callback_data: `deposit_abyssinia_${amount}` }], [{ text: '💳 CBE Birr', callback_data: `deposit_cbe_${amount}` }], [{ text: '❌ Cancel', callback_data: 'back_to_menu' }]] } });
                        return;
                    } else {
                        return ctx.reply('❌ Minimum deposit amount is 50 Birr. Please enter a valid amount.');
                    }
                }
                const parsed = parseReceipt(messageText);
                if (!parsed) { return ctx.reply('❌ Could not detect amount in your message.\n\n💡 Please paste the full receipt from your payment method.\n\n📋 Make sure it contains the amount (minimum ETB 50).'); }
                let user = await UserService.getUserByTelegramId(userId);
                if (!user) { user = await UserService.createOrUpdateUser(ctx.from); }
                const result = await WalletService.processDeposit(user._id, parsed.amount, parsed);
                const w = result.wallet;
                const paymentType = parsed.type === 'telebirr' ? '📱 Telebirr' : parsed.type === 'commercial' ? '🏦 Commercial Bank' : parsed.type === 'abyssinia' ? '🏛️ Abyssinia Bank' : parsed.type === 'cbe' ? '💳 CBE Birr' : '💳 Payment';
                const keyboard = { inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]] };
                if (isHttpsWebApp) keyboard.inline_keyboard.unshift([{ text: '🎮 Start Playing', web_app: { url: WEBAPP_URL } }]);
                return ctx.reply(`✅ Deposit Successful!\n\n${paymentType} deposit of ETB ${parsed.amount.toFixed(2)} has been credited to your wallet!\n\n💰 Main Wallet: ETB ${w.main.toFixed(2)}\n🎮 Play Balance: ETB ${w.play.toFixed(2)}\n🪙 Coins: ${w.coins.toFixed(0)}\n\n🎮 Ready to play!`, { reply_markup: keyboard });
            } catch (error) {
                console.error('SMS deposit error:', error);
                ctx.reply('❌ Deposit failed. Please try again or contact support.');
            }
        });

        bot.on(['photo', 'video', 'document', 'audio', 'voice', 'sticker', 'animation'], async (ctx) => {
            const adminId = String(ctx.from.id);
            const state = adminStates.get(adminId);
            if (!state || (state.mode !== 'broadcast' && state.mode !== 'await_caption_media')) return;
            const isAdmin = await isAdminByDB(adminId);
            if (!isAdmin) return;
            try {
                let targets = [];
                targets = await getBroadcastTargets();
                if (ctx.message.photo) {
                    const best = ctx.message.photo[ctx.message.photo.length - 1];
                    const fileId = best?.file_id;
                    const caption = ctx.message.caption || '';
                    if (!caption) {
                        adminStates.set(adminId, { mode: 'await_caption_media', pending: { kind: 'photo', fileId } });
                        await ctx.reply('✍️ Type caption for this image, or tap Skip.', { reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'skip_broadcast_caption' }]] } });
                    } else {
                        adminStates.delete(adminId);
                        const options = buildBroadcastMarkup(caption);
                        const { success, failed, total } = await sendToAll(targets, async (id) => { await bot.telegram.sendPhoto(id, fileId, options); });
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                } else if (ctx.message.video) {
                    const fileId = ctx.message.video.file_id;
                    const caption = ctx.message.caption || '';
                    if (!caption) {
                        adminStates.set(adminId, { mode: 'await_caption_media', pending: { kind: 'video', fileId } });
                        await ctx.reply('✍️ Type caption for this video, or tap Skip.', { reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'skip_broadcast_caption' }]] } });
                    } else {
                        adminStates.delete(adminId);
                        const options = buildBroadcastMarkup(caption);
                        const { success, failed, total } = await sendToAll(targets, async (id) => { await bot.telegram.sendVideo(id, fileId, options); });
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                } else if (ctx.message.document) {
                    const fileId = ctx.message.document.file_id;
                    const caption = ctx.message.caption || '';
                    if (!caption) {
                        adminStates.set(adminId, { mode: 'await_caption_media', pending: { kind: 'document', fileId } });
                        await ctx.reply('✍️ Type caption for this document, or tap Skip.', { reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'skip_broadcast_caption' }]] } });
                    } else {
                        adminStates.delete(adminId);
                        const options = buildBroadcastMarkup(caption);
                        const { success, failed, total } = await sendToAll(targets, async (id) => { await bot.telegram.sendDocument(id, fileId, options); });
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                } else if (ctx.message.audio) {
                    const fileId = ctx.message.audio.file_id;
                    const options = buildBroadcastMarkup('');
                    const { success, failed, total } = await sendToAll(targets, async (id) => { await bot.telegram.sendAudio(id, fileId, options); });
                    await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                } else if (ctx.message.voice) {
                    const fileId = ctx.message.voice.file_id;
                    const options = buildBroadcastMarkup('');
                    const { success, failed, total } = await sendToAll(targets, async (id) => { await bot.telegram.sendVoice(id, fileId, options); });
                    await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                } else if (ctx.message.sticker) {
                    const fileId = ctx.message.sticker.file_id;
                    const { success, failed, total } = await sendToAll(targets, async (id) => { await bot.telegram.sendSticker(id, fileId); });
                    await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                } else if (ctx.message.animation) {
                    const fileId = ctx.message.animation.file_id;
                    const caption = ctx.message.caption || '';
                    if (!caption) {
                        adminStates.set(adminId, { mode: 'await_caption_media', pending: { kind: 'animation', fileId } });
                        await ctx.reply('✍️ Type caption for this animation, or tap Skip.', { reply_markup: { inline_keyboard: [[{ text: '⏭️ Skip', callback_data: 'skip_broadcast_caption' }]] } });
                    } else {
                        adminStates.delete(adminId);
                        const options = buildBroadcastMarkup(caption);
                        const { success, failed, total } = await sendToAll(targets, async (id) => { await bot.telegram.sendAnimation(id, fileId, options); });
                        await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
                    }
                }
            } catch (e) {
                const msg = e && e.message === 'NO_RECIPIENTS' ? '❌ No recipients found in database.' : '❌ Failed to broadcast.';
                await ctx.reply(msg, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
            }
        });

        bot.action('skip_broadcast_caption', async (ctx) => {
            const adminId = String(ctx.from.id);
            const isAdmin = await isAdminByDB(adminId);
            if (!isAdmin) return;
            const state = adminStates.get(adminId);
            if (!state || state.mode !== 'await_caption_media') return;
            adminStates.delete(adminId);
            try {
                const result = await sendPendingMediaToAll(state.pending, '');
                const { success, failed, total } = result;
                await ctx.reply(`📣 Broadcast result: ✅ ${success} / ${total} delivered${failed ? `, ❌ ${failed} failed` : ''}.`, { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
            } catch {
                await ctx.reply('❌ Failed to broadcast.', { reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_to_admin' }]] } });
            }
        });

        bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => { });
        bot.telegram.getMe()
            .then((me) => { console.log(`🤖 Starting Telegram bot @${me.username}`); return bot.launch(); })
            .then(() => console.log('✅ Telegram bot started with long polling'))
            .catch((err) => console.error('❌ Failed to start Telegram bot:', err));

        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } catch { }
}

module.exports = { startTelegramBot };
