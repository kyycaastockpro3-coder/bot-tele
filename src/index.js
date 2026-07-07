const fs = require('node:fs/promises');
const path = require('node:path');
const { Telegraf, Markup } = require('telegraf');
const QRCode = require('qrcode');
require('dotenv').config();

const botToken = process.env.BOT_TOKEN;
const ownerId = process.env.OWNER_ID;
const developerId = process.env.DEVELOPER_ID;
const adminIds = [ownerId, developerId].filter(Boolean).map(String);
const storeName = process.env.STORE_NAME || 'Toko Digital';
const paymentInfo = process.env.PAYMENT_INFO || 'Hubungi admin untuk pembayaran.';
const qrisText = process.env.QRIS_TEXT || '00020101021126610014COM.GO-JEK.WWW01189360091434481656930210G4481656930303UMI51440014ID.CO.QRIS.WWW0215ID10265393264900303UMI5204899953033605802ID5925Crew_store, Digital & Kre6010PEKALONGAN61055117362070703A0163044693';
const ownerUsername = process.env.OWNER_USERNAME || '';
const menuIconUrl = process.env.MENU_ICON_URL || 'https://e.top4top.io/p_3840ywgm11.jpg';
const dataDir = process.env.VERCEL ? '/tmp' : path.join(__dirname, '..');
const ownerUrl = ownerUsername ? `https://t.me/${ownerUsername.replace(/^@/, '')}` : null;
const sourceProductsPath = path.join(__dirname, '..', 'products.json');
const productsPath = path.join(dataDir, 'products.json');
const ordersPath = path.join(dataDir, 'orders.json');
const settingsPath = path.join(dataDir, 'settings.json');

if (!botToken) {
  throw new Error('BOT_TOKEN belum diisi. Salin .env.example menjadi .env lalu isi token bot.');
}

const bot = new Telegraf(botToken);
const adminSessions = new Map();
const catalogSessions = new Map();
const lastBotMessages = new Map();

const formatRupiah = (value) => new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0
}).format(value);

const crc16 = (value) => {
  let crc = 0xffff;

  for (let index = 0; index < value.length; index += 1) {
    crc ^= value.charCodeAt(index) << 8;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
};

const createDynamicQris = (amount) => {
  const cleanQris = qrisText.trim().replace(/6304[0-9A-Fa-f]{4}$/, '').replace('010211', '010212');
  const amountText = String(amount);
  const amountTag = `54${amountText.length.toString().padStart(2, '0')}${amountText}`;
  const payload = `${cleanQris.replace(/5802ID/, `${amountTag}5802ID`)}6304`;

  return `${payload}${crc16(payload)}`;
};

const readJson = async (filePath, fallback) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = async (filePath, data) => {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const ensureData = async () => {
  try {
    await fs.access(productsPath);
  } catch {
    const products = await readJson(sourceProductsPath, []);
    await writeJson(productsPath, products);
  }

  try {
    await fs.access(ordersPath);
  } catch {
    await writeJson(ordersPath, []);
  }

  try {
    await fs.access(settingsPath);
  } catch {
    await writeJson(settingsPath, { mode: 'public', bannedUsers: [] });
  }
};

const getProducts = async () => {
  await ensureData();
  return readJson(productsPath, []);
};

const getOrders = async () => {
  await ensureData();
  return readJson(ordersPath, []);
};

const getSettings = async () => {
  await ensureData();
  return readJson(settingsPath, { mode: 'public', bannedUsers: [] });
};

const writeSettings = async (settings) => {
  await writeJson(settingsPath, settings);
};

const isAdmin = (ctx) => adminIds.includes(String(ctx.from.id));

bot.use(async (ctx, next) => {
  if (!ctx.from || isAdmin(ctx)) {
    await next();
    return;
  }

  const settings = await getSettings();
  const userId = String(ctx.from.id);

  if ((settings.bannedUsers || []).includes(userId)) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('Akun kamu dibanned.');
      return;
    }

    await ctx.reply('Akun kamu dibanned dan tidak bisa memakai bot ini.');
    return;
  }

  if (settings.mode === 'self') {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('Bot sedang mode self.');
      return;
    }

    await ctx.reply('Bot sedang mode self. Hanya admin, owner, dan developer yang bisa memakai bot.');
    return;
  }

  await next();
});

const sendAdmins = async (ctx, message, extra) => {
  for (const adminId of adminIds) {
    try {
      await ctx.telegram.sendMessage(adminId, message, extra);
    } catch {}
  }
};

const editOrReply = async (ctx, message, extra) => {
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.deleteMessage();
    } catch {}
  }

  await replyClean(ctx, message, extra);
};

const deleteLastBotMessage = async (ctx) => {
  const messageId = lastBotMessages.get(ctx.chat?.id);

  if (!messageId) {
    return;
  }

  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
  } catch {}
};

const trackBotMessage = (ctx, message) => {
  if (ctx.chat?.id && message?.message_id) {
    lastBotMessages.set(ctx.chat.id, message.message_id);
  }
};

const replyClean = async (ctx, message, extra) => {
  await deleteLastBotMessage(ctx);
  const sent = await ctx.reply(message, extra);
  trackBotMessage(ctx, sent);
  return sent;
};

const replyMenu = async (ctx, message, extra) => {
  await deleteLastBotMessage(ctx);

  try {
    const sent = await ctx.replyWithPhoto(menuIconUrl, { caption: message, ...extra });
    trackBotMessage(ctx, sent);
    return;
  } catch {}

  const sent = await ctx.reply(message, extra);
  trackBotMessage(ctx, sent);
};

const createProductId = (name) => name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || Date.now().toString();

const parseProductInput = (text) => {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const data = {};

  for (const line of lines) {
    const [key, ...valueParts] = line.split(':');

    if (!key || !valueParts.length) {
      continue;
    }

    data[key.trim().toLowerCase()] = valueParts.join(':').trim();
  }

  return data;
};

const productIcon = (product) => product.icon || '🛍️';

const productCard = (product) => [`🆔 ${product.id}`, `${productIcon(product)} ${product.name}`, `💰 ${formatRupiah(product.price)}`, `📦 Stok: ${product.stock.length}`, `📝 ${product.description}`].join('\n');

const productButtonLabel = (product) => `${productIcon(product)} ${product.name}`;

const compactProductLine = (product, index) => `◽ ${index + 1}. ${productButtonLabel(product)}\n   ${formatRupiah(product.price)} • Stok ${product.stock.length}`;

const productBaseName = (product) => (product.groupName || product.name)
  .replace(/\b\d+\s*(hari|day|days|bulan|month|months|tahun|year|years)\b/gi, '')
  .replace(/\b(akun|privat|private|via|x premium|garansi|ideal)\b/gi, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();

const productVariantName = (product) => product.name.replace(new RegExp(productBaseName(product).split(' ').join('.*'), 'i'), '').trim() || product.description.split('.')[0] || product.name;

const groupProducts = (products) => Object.values(products.reduce((groups, product) => {
  const name = productBaseName(product);
  groups[name] = groups[name] || { name, icon: productIcon(product), products: [] };
  groups[name].products.push(product);
  return groups;
}, {}));

const productListMessage = (groups, page = 0) => {
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  const items = groups.slice(page * pageSize, page * pageSize + pageSize);

  return [
    '╭─ 〔 CREW PRODUCT LIST 〕 ─╮',
    `│ Page ${page + 1}/${totalPages}  •  Total ${groups.length} produk`,
    '├────────────────────────',
    ...items.map((group, index) => `│ ${page * pageSize + index + 1} │ ${group.name}`),
    '╰───────────────────────╯',
    'Pilih nomor produk lewat tombol di bawah.'
  ].join('\n');
};

const adminProductListMessage = (products, page = 0) => {
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(products.length / pageSize));
  const items = products.slice(page * pageSize, page * pageSize + pageSize);

  return [
    '╭─ 〔 CREW ADMIN PRODUCT 〕 ─╮',
    `│ Page ${page + 1}/${totalPages}  •  Total ${products.length} produk`,
    '├────────────────────────',
    ...items.map((product, index) => `│ ${page * pageSize + index + 1} │ ${product.name.toUpperCase()} • Stok ${product.stock.length}`),
    '╰───────────────────────╯',
    'Pilih nomor produk lewat tombol di bawah.'
  ].join('\n');
};

const mainMenuButtons = () => Markup.inlineKeyboard([
  [Markup.button.callback('🛍️ Katalog', 'menu:catalog'), Markup.button.callback('📦 Pesanan Saya', 'menu:orders')],
  [Markup.button.callback('📝 Cara Beli', 'menu:guide'), Markup.button.callback('💬 Bantuan', 'menu:help')]
]);

const catalogKeyboard = (groups, page = 0) => {
  const pageSize = 10;
  const start = page * pageSize;
  const buttons = groups.slice(start, start + pageSize).map((group, index) => Markup.button.callback(String(start + index + 1), `catalog:group:${start + index}`));
  const rows = [];

  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(buttons.slice(index, index + 5));
  }

  const navigation = [];

  if (page > 0) {
    navigation.push(Markup.button.callback('⬅️ Preview', `catalog:page:${page - 1}`));
  }

  if (start + pageSize < groups.length) {
    navigation.push(Markup.button.callback('➡️ Next', `catalog:page:${page + 1}`));
  }

  if (navigation.length) {
    rows.push(navigation);
  }

  rows.push([Markup.button.callback('🏠 Home', 'menu:home')]);
  return Markup.inlineKeyboard(rows);
};

const variantKeyboard = (group) => Markup.inlineKeyboard([
  ...group.products.map((product) => [Markup.button.callback(`${productVariantName(product)} • ${formatRupiah(product.price)}`, `catalog:item:${product.id}`)]),
  [Markup.button.callback('⬅️ Kembali ke List', 'catalog:list'), Markup.button.callback('🏠 Home', 'menu:home')]
]);

const productDetailButtons = (product) => Markup.inlineKeyboard([
  [Markup.button.callback(`🛒 Beli ${productIcon(product)}`, `buy:${product.id}`)],
  [Markup.button.callback('⬅️ Kembali ke Katalog', 'catalog:list'), Markup.button.callback('💬 Tanya Owner', 'contact_owner')]
]);

const paymentButtons = (orderId) => Markup.inlineKeyboard([
  [Markup.button.callback('✅ Saya sudah membayar', `paid:${orderId}`)],
  [Markup.button.callback('❌ Cancel', `cancel_order:${orderId}`), ownerUrl ? Markup.button.url('💬 Tanya Owner', ownerUrl) : Markup.button.callback('💬 Tanya Owner', 'contact_owner')]
]);

const formatStockList = (product) => {
  if (!product.stock.length) {
    return '❌ Stok habis';
  }

  return product.stock.map((item, index) => `${index + 1}. ${item}`).join('\n');
};

const parseStockText = (text) => text
  .split(/[\n,]+/)
  .map((item) => item.trim().replace(/^\d+[.)]\s*/, ''))
  .filter(Boolean);

const stockManageMessage = (product) => [`📦 Kelola Stok`, '', `${productIcon(product)} ${product.name}`, `Jumlah stok realtime: ${product.stock.length}`, '', formatStockList(product), '', 'Untuk mengubah stok: tekan Update Data Stok, lalu kirim ulang teks stok bernomor yang sudah kamu edit.'].join('\n');

const addProductMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('🆕 Buat List Produk Baru', 'admin:add_product:new')],
  [Markup.button.callback('➕ Tambah Variasi/Durasi', 'admin:add_product:variant')],
  [Markup.button.callback('⬅️ Kembali', 'admin:panel')]
]);

const productGroupSelectKeyboard = (groups) => Markup.inlineKeyboard([
  ...groups.map((group, index) => [Markup.button.callback(`${index + 1}. ${group.name}`, `admin:add_variant_group:${index}`)]),
  [Markup.button.callback('⬅️ Kembali', 'admin:add_product')]
]);

const productGroupDeleteKeyboard = (groups) => Markup.inlineKeyboard([
  ...groups.map((group, index) => [Markup.button.callback(`${index + 1}. ${group.name}`, `admin:delete_group:${index}`)]),
  [Markup.button.callback('⬅️ Kembali', 'admin:panel')]
]);

const adminProductMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('➕ Tambah Produk', 'admin:add_product')],
  [Markup.button.callback('📋 Kelola Produk', 'admin:list_products')],
  [Markup.button.callback('🧹 Hapus List Produk', 'admin:delete_group_menu')],
  [Markup.button.callback('🔐 Mode Bot', 'admin:bot_mode')],
  [Markup.button.callback('🚫 Ban User', 'admin:ban_user'), Markup.button.callback('✅ Unban User', 'admin:unban_user')],
  [Markup.button.callback('📢 Broadcast Pembeli', 'admin:broadcast')],
  [Markup.button.callback('🏠 Home', 'menu:home')]
]);

const productManageButtons = (productId) => Markup.inlineKeyboard([
  [Markup.button.callback('✏️ Ubah Data Produk', `admin:edit_product:${productId}`)],
  [Markup.button.callback('📦 Kelola Stok', `admin:stock_menu:${productId}`)],
  [Markup.button.callback('🗑️ Hapus Produk', `admin:delete_product:${productId}`)],
  [Markup.button.callback('⬅️ Kembali ke List Produk', 'admin:list_products')]
]);

const productEditButtons = (productId) => Markup.inlineKeyboard([
  [Markup.button.callback('🏷️ Ubah Nama', `admin:edit_field:name:${productId}`), Markup.button.callback('💰 Ubah Harga', `admin:edit_field:price:${productId}`)],
  [Markup.button.callback('📝 Ubah Deskripsi', `admin:edit_field:description:${productId}`)],
  [Markup.button.callback('⬅️ Kembali', `admin:show_product:${productId}`)]
]);

const productStockButtons = (productId) => Markup.inlineKeyboard([
  [Markup.button.callback('✏️ Update Data Stok', `admin:set_stock:${productId}`)],
  [Markup.button.callback('🧹 Kosongkan Stok', `admin:clear_stock:${productId}`)],
  [Markup.button.callback('⬅️ Kembali', `admin:show_product:${productId}`)]
]);

const adminProductsKeyboard = (products, page = 0) => {
  const pageSize = 10;
  const start = page * pageSize;
  const buttons = products.slice(start, start + pageSize).map((product, index) => Markup.button.callback(String(start + index + 1), `admin:show_product:${product.id}`));
  const rows = [];

  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(buttons.slice(index, index + 5));
  }

  const navigation = [];

  if (page > 0) {
    navigation.push(Markup.button.callback('⬅️ Preview', `admin:products_page:${page - 1}`));
  }

  if (start + pageSize < products.length) {
    navigation.push(Markup.button.callback('➡️ Next', `admin:products_page:${page + 1}`));
  }

  if (navigation.length) {
    rows.push(navigation);
  }

  rows.push([Markup.button.callback('🏠 Home', 'menu:home'), Markup.button.callback('🛠️ Admin Panel', 'admin:panel')]);
  return Markup.inlineKeyboard(rows);
};

const mainMenu = (ctx) => {
  const rows = [
    [Markup.button.callback('🛍️ Katalog', 'menu:catalog'), Markup.button.callback('📦 Pesanan Saya', 'menu:orders')],
    [Markup.button.callback('📝 Cara Beli', 'menu:guide'), ownerUrl ? Markup.button.url('💬 Bantuan', ownerUrl) : Markup.button.callback('💬 Bantuan', 'menu:help')]
  ];

  if (isAdmin(ctx)) {
    rows.push([Markup.button.callback('🛠️ Admin Panel', 'admin:panel')]);
  }

  return Markup.inlineKeyboard(rows);
};

const ownerButtons = () => {
  if (!ownerUrl) {
    return Markup.inlineKeyboard([
      Markup.button.callback('💬 Pesan Owner', 'contact_owner')
    ]);
  }

  return Markup.inlineKeyboard([
    Markup.button.url('💬 Pesan Owner', ownerUrl)
  ]);
};

const welcomeMessage = () => [
  `👋 Halo, selamat datang di ${storeName}!`,
  '',
  'Aku siap bantu kamu belanja produk digital dengan cepat dan nyaman.',
  '',
  '✨ Pilih menu di bawah ya:',
  '🛍️ Katalog untuk lihat produk',
  '📦 Pesanan Saya untuk cek status order',
  '📝 Cara Beli untuk panduan transaksi',
  '💬 Bantuan kalau butuh owner'
].join('\n');

bot.start(async (ctx) => {
  await replyMenu(ctx, welcomeMessage(), mainMenu(ctx));
});

bot.action('menu:home', async (ctx) => {
  catalogSessions.delete(ctx.from.id);
  adminSessions.delete(ctx.from.id);
  await ctx.answerCbQuery('Memuat...');
  await replyMenu(ctx, welcomeMessage(), mainMenu(ctx));
});

const sendCatalog = async (ctx, page = 0) => {
  const products = await getProducts();
  const availableProducts = products.filter((product) => product.stock.length > 0);

  if (!availableProducts.length) {
    await editOrReply(ctx, '😔 Stok sedang kosong. Cek lagi nanti atau hubungi owner ya.', ownerButtons());
    return;
  }

  const groups = groupProducts(availableProducts);
  catalogSessions.set(ctx.from.id, { page });
  await replyMenu(ctx, productListMessage(groups, page), catalogKeyboard(groups, page));
};

bot.action('menu:catalog', async (ctx) => {
  await ctx.answerCbQuery('Memuat...');
  await sendCatalog(ctx);
});

bot.action(/^catalog:page:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Memuat...');
  await sendCatalog(ctx, Number(ctx.match[1]));
});

bot.hears(['Katalog', '🛍️ Katalog'], async (ctx) => {
  const products = await getProducts();
  const availableProducts = products.filter((product) => product.stock.length > 0);

  if (!availableProducts.length) {
    await ctx.reply('😔 Stok sedang kosong. Cek lagi nanti atau hubungi owner ya.', ownerButtons());
    return;
  }

  const groups = groupProducts(availableProducts);
  catalogSessions.set(ctx.from.id, { page: 0 });
  await replyMenu(ctx, productListMessage(groups), catalogKeyboard(groups));
});

bot.action('menu:guide', async (ctx) => {
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['╭─ 〔 CARA BELI 〕 ─╮', '│ 1. Tekan menu 🛍️ Katalog', '│ 2. Pilih list produk', '│ 3. Pilih variasi/durasi produk', '│ 4. Tekan tombol 🛒 Beli', '│ 5. Scan QRIS yang dikirim bot', '│ 6. Nominal QRIS otomatis sesuai harga', '│ 7. Setelah bayar, tekan ✅ Saya sudah membayar', '│ 8. Tunggu admin accept pembayaran', '│ 9. Jika sudah di-ACC, stok/data akun dikirim otomatis', '╰───────────────────────╯', '', 'Jika ada kendala, tekan tombol Bantuan untuk chat owner.'].join('\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'menu:home')]]));
});

bot.action('menu:help', async (ctx) => {
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, '💬 Butuh bantuan? Tekan tombol owner di bawah.', Markup.inlineKeyboard([[ownerUrl ? Markup.button.url('💬 Pesan Owner', ownerUrl) : Markup.button.callback('💬 Pesan Owner', 'contact_owner')], [Markup.button.callback('⬅️ Kembali', 'menu:home')]]));
});

bot.action('menu:orders', async (ctx) => {
  const orders = await getOrders();
  const userOrders = orders.filter((order) => order.userId === ctx.from.id).slice(-5).reverse();
  await ctx.answerCbQuery('Memuat...');

  if (!userOrders.length) {
    await editOrReply(ctx, '📦 Kamu belum punya pesanan. Yuk lihat katalog dulu.', Markup.inlineKeyboard([[Markup.button.callback('🛍️ Katalog', 'menu:catalog')], [Markup.button.callback('⬅️ Kembali', 'menu:home')]]));
    return;
  }

  await editOrReply(ctx, userOrders.map((order) => `#${order.id}\n🛍️ ${order.productName}\n📌 Status: ${order.status}`).join('\n\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'menu:home')]]));
});

bot.hears(['Cara Beli', '📝 Cara Beli'], async (ctx) => {
  await replyClean(ctx, ['╭─ 〔 CARA BELI 〕 ─╮', '│ 1. Tekan menu 🛍️ Katalog', '│ 2. Pilih list produk', '│ 3. Pilih variasi/durasi produk', '│ 4. Tekan tombol 🛒 Beli', '│ 5. Scan QRIS yang dikirim bot', '│ 6. Nominal QRIS otomatis sesuai harga', '│ 7. Setelah bayar, tekan ✅ Saya sudah membayar', '│ 8. Tunggu admin accept pembayaran', '│ 9. Jika sudah di-ACC, stok/data akun dikirim otomatis', '╰───────────────────────╯', '', 'Jika ada kendala, tekan tombol Bantuan untuk chat owner.'].join('\n'), mainMenu(ctx));
});

bot.hears(['Bantuan', '💬 Bantuan'], async (ctx) => {
  await ctx.reply('💬 Butuh bantuan? Kamu bisa kirim pesan ke bot ini atau langsung tekan tombol Pesan Owner di bawah.', ownerButtons());
});

bot.action(/^catalog:group:(\d+)$/, async (ctx) => {
  const products = await getProducts();
  const groups = groupProducts(products.filter((product) => product.stock.length > 0));
  const group = groups[Number(ctx.match[1])];

  if (!group) {
    await ctx.answerCbQuery('Produk tidak ditemukan.');
    return;
  }

  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, [`╭─ 〔 ${group.name} 〕 ─╮`, `│ Total variasi: ${group.products.length}`, '╰───────────────────────╯', 'Pilih variasi produk lewat tombol di bawah.'].join('\n'), variantKeyboard(group));
});

bot.action(/^catalog:item:(.+)$/, async (ctx) => {
  const products = await getProducts();
  const product = products.find((item) => item.id === ctx.match[1] && item.stock.length > 0);

  if (!product) {
    await ctx.answerCbQuery('Produk kosong atau tidak ditemukan.');
    return;
  }

  catalogSessions.set(ctx.from.id, { ...(catalogSessions.get(ctx.from.id) || { page: 0 }), selectedProductId: product.id });
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(
    ctx,
    [`${productIcon(product)} ${product.name}`, '', `💰 Harga: ${formatRupiah(product.price)}`, `📦 Stok: ${product.stock.length}`, '', `📝 ${product.description}`, '', 'Pilih aksi di tombol bawah pesan ini.'].join('\n'),
    productDetailButtons(product)
  );
});

bot.action('catalog:list', async (ctx) => {
  const products = await getProducts();
  const availableProducts = products.filter((product) => product.stock.length > 0);
  const session = catalogSessions.get(ctx.from.id) || { page: 0 };

  if (!availableProducts.length) {
    await ctx.answerCbQuery('Stok kosong.');
    await ctx.reply('😔 Stok sedang kosong. Cek lagi nanti atau hubungi owner ya.', ownerButtons());
    return;
  }

  const groups = groupProducts(availableProducts);
  session.selectedProductId = null;
  catalogSessions.set(ctx.from.id, session);
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, productListMessage(groups, session.page), catalogKeyboard(groups, session.page));
});

bot.hears(['➡️ Selanjutnya', '⬅️ Sebelumnya', '⬅️ Kembali ke Katalog'], async (ctx) => {
  const products = await getProducts();
  const availableProducts = products.filter((product) => product.stock.length > 0);
  const session = catalogSessions.get(ctx.from.id) || { page: 0 };

  if (ctx.message.text === '➡️ Selanjutnya') {
    session.page += 1;
  }

  if (ctx.message.text === '⬅️ Sebelumnya') {
    session.page = Math.max(0, session.page - 1);
  }

  if (ctx.message.text === '⬅️ Kembali ke Katalog') {
    session.selectedProductId = null;
  }

  const groups = groupProducts(availableProducts);
  catalogSessions.set(ctx.from.id, session);
  await replyMenu(ctx, productListMessage(groups, session.page), catalogKeyboard(groups, session.page));
});

bot.hears(['➡️ Produk Selanjutnya', '⬅️ Produk Sebelumnya'], async (ctx) => {
  if (!isAdmin(ctx)) {
    return;
  }

  const session = adminSessions.get(ctx.from.id);

  if (session?.action !== 'manage_products') {
    return;
  }

  const products = await getProducts();

  if (ctx.message.text === '➡️ Produk Selanjutnya') {
    session.page += 1;
  }

  if (ctx.message.text === '⬅️ Produk Sebelumnya') {
    session.page = Math.max(0, session.page - 1);
  }

  adminSessions.set(ctx.from.id, session);
  await replyMenu(
    ctx,
    adminProductListMessage(products, session.page),
    adminProductsKeyboard(products, session.page)
  );
});

bot.hears(/^\d+$/, async (ctx, next) => {
  const products = await getProducts();
  const adminSession = adminSessions.get(ctx.from.id);

  if (isAdmin(ctx) && adminSession && adminSession.action !== 'manage_products') {
    await next();
    return;
  }

  if (isAdmin(ctx) && adminSession?.action === 'manage_products') {
    const product = products[Number(ctx.message.text) - 1];

    if (!product) {
      await ctx.reply('Produk tidak ditemukan. Pilih nomor yang ada di list.');
      return;
    }

    await replyClean(ctx, productCard(product), productManageButtons(product.id));
    return;
  }

  const availableProducts = products.filter((product) => product.stock.length > 0);
  const product = availableProducts[Number(ctx.message.text) - 1];

  if (!product) {
    await ctx.reply('Produk tidak ditemukan. Pilih nomor yang ada di list.');
    return;
  }

  catalogSessions.set(ctx.from.id, { ...(catalogSessions.get(ctx.from.id) || { page: 0 }), selectedProductId: product.id });
  await ctx.reply(
    [`${productIcon(product)} ${product.name}`, '', `💰 Harga: ${formatRupiah(product.price)}`, `📦 Stok: ${product.stock.length}`, '', `📝 ${product.description}`, '', 'Pilih aksi di tombol bawah pesan ini.'].join('\n'),
    productDetailButtons(product)
  );
});

bot.hears(['🏠 Menu Utama', '🏠 Home'], async (ctx) => {
  catalogSessions.delete(ctx.from.id);
  adminSessions.delete(ctx.from.id);
  await ctx.reply('Menu utama:', mainMenu(ctx));
});

bot.hears(['Pesanan Saya', '📦 Pesanan Saya'], async (ctx) => {
  const orders = await getOrders();
  const userOrders = orders.filter((order) => order.userId === ctx.from.id).slice(-5).reverse();

  if (!userOrders.length) {
    await ctx.reply('📦 Kamu belum punya pesanan. Yuk lihat katalog dulu.', mainMenu(ctx));
    return;
  }

  await ctx.reply(userOrders.map((order) => `#${order.id}\n🛍️ ${order.productName}\n📌 Status: ${order.status}`).join('\n\n'), mainMenu(ctx));
});

bot.hears('🛒 Beli Produk Ini', async (ctx) => {
  const session = catalogSessions.get(ctx.from.id);
  const productId = session?.selectedProductId;
  const products = await getProducts();
  const product = products.find((item) => item.id === productId);

  if (!product || product.stock.length === 0) {
    await ctx.reply('Produk kosong atau tidak ditemukan. Buka katalog lagi ya.', mainMenu(ctx));
    return;
  }

  const orders = await getOrders();
  const order = {
    id: Date.now().toString(),
    userId: ctx.from.id,
    username: ctx.from.username || ctx.from.first_name,
    productId: product.id,
    productName: product.name,
    price: product.price,
    status: 'Menunggu pembayaran',
    createdAt: new Date().toISOString()
  };

  orders.push(order);
  await writeJson(ordersPath, orders);
  const qrisBuffer = await QRCode.toBuffer(createDynamicQris(product.price), { margin: 1, width: 360 });
  await ctx.replyWithPhoto(
    { source: qrisBuffer },
    {
      caption: [`✅ Pesanan #${order.id} berhasil dibuat`, '', `🛍️ Produk: ${product.name}`, `💰 Total: ${formatRupiah(product.price)}`, '', 'Scan QRIS ini. Nominal sudah otomatis sesuai harga produk.', '', 'Jika sudah transfer, tekan tombol di bawah.'].join('\n'),
      ...paymentButtons(order.id)
    }
  );
});

bot.action(/^buy:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const products = await getProducts();
  const product = products.find((item) => item.id === productId);

  if (!product || product.stock.length === 0) {
    await ctx.answerCbQuery('Produk kosong atau tidak ditemukan.');
    return;
  }

  const orders = await getOrders();
  const order = {
    id: Date.now().toString(),
    userId: ctx.from.id,
    username: ctx.from.username || ctx.from.first_name,
    productId: product.id,
    productName: product.name,
    price: product.price,
    status: 'Menunggu pembayaran',
    createdAt: new Date().toISOString()
  };

  orders.push(order);
  await writeJson(ordersPath, orders);
  const qrisBuffer = await QRCode.toBuffer(createDynamicQris(product.price), { margin: 1, width: 360 });
  await ctx.answerCbQuery('Pesanan dibuat.');
  await ctx.replyWithPhoto(
    { source: qrisBuffer },
    {
      caption: [`✅ Pesanan #${order.id} berhasil dibuat`, '', `🛍️ Produk: ${product.name}`, `💰 Total: ${formatRupiah(product.price)}`, '', 'Scan QRIS ini. Nominal sudah otomatis sesuai harga produk.', '', 'Jika sudah transfer, tekan tombol di bawah.'].join('\n'),
      ...paymentButtons(order.id)
    }
  );
});

bot.action(/^cancel_order:(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const orders = await getOrders();
  const order = orders.find((item) => item.id === orderId && item.userId === ctx.from.id);

  if (!order) {
    await ctx.answerCbQuery('Pesanan tidak ditemukan.');
    return;
  }

  if (order.status !== 'Menunggu pembayaran') {
    await ctx.answerCbQuery('Pesanan sudah diproses.');
    return;
  }

  order.status = 'Dibatalkan';
  order.cancelledAt = new Date().toISOString();
  await writeJson(ordersPath, orders);
  await ctx.answerCbQuery('Pesanan dibatalkan.');
  await ctx.editMessageCaption([`❌ Pesanan #${order.id} dibatalkan`, '', `Produk: ${order.productName}`, `Total: ${formatRupiah(order.price)}`].join('\n'), Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'menu:home')]]));
});

bot.action(/^paid:(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const orders = await getOrders();
  const order = orders.find((item) => item.id === orderId && item.userId === ctx.from.id);

  if (!order) {
    await ctx.answerCbQuery('Pesanan tidak ditemukan.');
    return;
  }

  if (order.status !== 'Menunggu pembayaran') {
    await ctx.answerCbQuery('Pesanan sudah diproses.');
    return;
  }

  order.status = 'Menunggu konfirmasi admin';
  order.paidAt = new Date().toISOString();
  await writeJson(ordersPath, orders);
  await ctx.answerCbQuery('Pembayaran dikirim ke admin.');
  await ctx.editMessageCaption([`⏳ Pembayaran sedang dicek admin...`, '', `Pesanan #${order.id}`, `Produk: ${order.productName}`, `Total: ${formatRupiah(order.price)}`].join('\n'));
  await ctx.reply('✅ Laporan pembayaran diterima. Mohon tunggu konfirmasi admin ya.', mainMenu(ctx));

  const paidDate = new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta'
  }).format(new Date(order.paidAt));

  for (const adminId of adminIds) {
    try {
      await ctx.telegram.sendMessage(
        adminId,
        [`💳 User sudah membayar`, '', `Order: #${order.id}`, `ID: ${order.userId}`, `Username: @${order.username || '-'}`, `Produk: ${order.productName}`, `Total: ${formatRupiah(order.price)}`, `Waktu: ${paidDate}`].join('\n'),
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Accept', `confirm:${order.id}`),
          Markup.button.callback('❌ Reject', `reject:${order.id}`)
        ])
      );
    } catch {}
  }
});

bot.on('photo', async (ctx) => {
  const orders = await getOrders();
  const order = [...orders].reverse().find((item) => item.userId === ctx.from.id && item.status === 'Menunggu pembayaran');

  if (!order) {
    await ctx.reply('Tidak ada pesanan yang menunggu pembayaran.', mainMenu(ctx));
    return;
  }

  order.status = 'Menunggu konfirmasi admin';
  await writeJson(ordersPath, orders);
  await ctx.reply(`✅ Bukti pembayaran untuk pesanan #${order.id} sudah diterima. Mohon tunggu konfirmasi admin ya.`, mainMenu(ctx));

  for (const adminId of adminIds) {
    try {
      await ctx.telegram.forwardMessage(adminId, ctx.chat.id, ctx.message.message_id);
      await ctx.telegram.sendMessage(
        adminId,
        `Konfirmasi pesanan #${order.id}?`,
        Markup.inlineKeyboard([
          Markup.button.callback('Konfirmasi & Kirim', `confirm:${order.id}`),
          Markup.button.callback('Tolak', `reject:${order.id}`)
        ])
      );
    } catch {}
  }
});

bot.action(/^confirm:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const orderId = ctx.match[1];
  const orders = await getOrders();
  const products = await getProducts();
  const order = orders.find((item) => item.id === orderId);
  const product = products.find((item) => item.id === order?.productId);

  if (!order || !product || !product.stock.length) {
    await ctx.answerCbQuery('Pesanan atau stok tidak tersedia.');
    return;
  }

  const item = product.stock.shift();
  order.status = 'Selesai';
  order.deliveredAt = new Date().toISOString();
  await writeJson(productsPath, products);
  await writeJson(ordersPath, orders);
  await ctx.telegram.sendMessage(order.userId, [`🎉 Pembayaran dikonfirmasi!`, '', `Pesanan #${order.id}`, `Produk: ${order.productName}`, '', 'Barang kamu:', item, '', `Terima kasih sudah belanja di ${storeName}.`].join('\n'));
  await ctx.answerCbQuery('Pesanan dikirim.');
  await ctx.editMessageText(`Pesanan #${order.id} sudah dikonfirmasi dan dikirim.`);
});

bot.action(/^reject:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const orderId = ctx.match[1];
  const orders = await getOrders();
  const order = orders.find((item) => item.id === orderId);

  if (!order) {
    await ctx.answerCbQuery('Pesanan tidak ditemukan.');
    return;
  }

  order.status = 'Ditolak';
  await writeJson(ordersPath, orders);
  await ctx.telegram.sendMessage(order.userId, `😔 Pesanan #${order.id} ditolak. Kalau pembayaran sudah benar, silakan hubungi owner ya.`, ownerButtons());
  await ctx.answerCbQuery('Pesanan ditolak.');
  await ctx.editMessageText(`Pesanan #${order.id} ditolak.`);
});

bot.action('contact_owner', async (ctx) => {
  await ctx.answerCbQuery();

  if (ownerUrl) {
    await ctx.reply('Klik tombol Pesan Owner di bawah ya.', ownerButtons());
    return;
  }

  if (adminIds.length) {
    await ctx.reply(`💬 Owner belum memasang username. Pesan kamu bisa dikirim ke bot ini, nanti admin akan bantu.`);
    await sendAdmins(ctx, `User butuh bantuan\nNama: ${ctx.from.first_name}\nUsername: @${ctx.from.username || '-'}\nID: ${ctx.from.id}`);
    return;
  }

  await ctx.reply('Owner belum tersedia. Coba lagi nanti ya.');
});

bot.action('admin:panel', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  await ctx.answerCbQuery('Memuat...');
  await replyMenu(ctx, ['🛠️ Admin Panel', '', 'Pilih fitur yang ingin kamu kelola lewat tombol di bawah.'].join('\n'), adminProductMenu());
});

bot.hears('🛠️ Admin Panel', async (ctx) => {
  if (!isAdmin(ctx)) {
    return;
  }

  await replyMenu(ctx, ['🛠️ Admin Panel', '', 'Pilih fitur yang ingin kamu kelola lewat tombol di bawah.'].join('\n'), adminProductMenu());
});

bot.action('admin:add_product', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['➕ Tambah Produk', '', 'Pilih jenis penambahan produk.'].join('\n'), addProductMenu());
});

bot.action('admin:add_product:new', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  adminSessions.set(ctx.from.id, { action: 'add_product_step', type: 'new', step: 'groupName', data: {} });
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['🆕 Buat List Produk Baru', '', 'Step 1/6', 'Kirim nama list produk.', '', 'Contoh:', 'CAPCUT'].join('\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'admin:add_product')]]));
});

bot.action('admin:add_product:variant', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const groups = groupProducts(await getProducts());
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['➕ Tambah Variasi/Durasi', '', 'Pilih list produk yang ingin ditambahkan variasinya.'].join('\n'), productGroupSelectKeyboard(groups));
});

bot.action(/^admin:add_variant_group:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const groups = groupProducts(await getProducts());
  const group = groups[Number(ctx.match[1])];

  if (!group) {
    await ctx.answerCbQuery('List produk tidak ditemukan.');
    return;
  }

  adminSessions.set(ctx.from.id, { action: 'add_product_step', type: 'variant', step: 'name', data: { groupName: group.name, icon: group.products[0]?.icon || '🛍️' } });
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['➕ Tambah Variasi/Durasi', '', `List produk: ${group.name}`, '', 'Step 1/4', 'Kirim nama variasi/durasi.', '', 'Contoh:', 'Grok AI Super 7 Day'].join('\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'admin:add_product:variant')]]));
});

bot.action('admin:bot_mode', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const settings = await getSettings();
  await ctx.answerCbQuery();
  await editOrReply(ctx, `Mode bot sekarang: ${settings.mode.toUpperCase()}`, Markup.inlineKeyboard([
    [Markup.button.callback('🌐 Public', 'admin:set_mode:public'), Markup.button.callback('🔒 Self', 'admin:set_mode:self')],
    [Markup.button.callback('⬅️ Kembali', 'admin:panel')]
  ]));
});

bot.action(/^admin:set_mode:(public|self)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const settings = await getSettings();
  settings.mode = ctx.match[1];
  await writeSettings(settings);
  await ctx.answerCbQuery('Mode bot diubah.');
  await ctx.editMessageText(`✅ Mode bot sekarang: ${settings.mode.toUpperCase()}`, adminProductMenu());
});

bot.action('admin:ban_user', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  adminSessions.set(ctx.from.id, { action: 'ban_user' });
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['🚫 Kirim ID Telegram user yang mau diban.', '', 'Contoh: 123456789'].join('\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'admin:panel')]]));
});

bot.action('admin:unban_user', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  adminSessions.set(ctx.from.id, { action: 'unban_user' });
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['✅ Kirim ID Telegram user yang mau di-unban.', '', 'Contoh: 123456789'].join('\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'admin:panel')]]));
});

bot.action('admin:broadcast', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  adminSessions.set(ctx.from.id, { action: 'broadcast' });
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['📢 Kirim pesan broadcast untuk pembeli.', '', 'Ketik isi pesan yang mau dikirim.'].join('\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'admin:panel')]]));
});

bot.action('admin:delete_group_menu', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const groups = groupProducts(await getProducts());
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['🧹 Hapus List Produk', '', 'Pilih list produk yang ingin dihapus.', 'Semua variasi di dalam list akan ikut terhapus.'].join('\n'), productGroupDeleteKeyboard(groups));
});

bot.action(/^admin:delete_group:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const groups = groupProducts(await getProducts());
  const group = groups[Number(ctx.match[1])];

  if (!group) {
    await ctx.answerCbQuery('List produk tidak ditemukan.');
    return;
  }

  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, [`⚠️ Hapus list produk ${group.name}?`, '', `Total variasi: ${group.products.length}`, 'Semua variasi dan stok di list ini akan dihapus.'].join('\n'), Markup.inlineKeyboard([
    [Markup.button.callback('✅ Ya, Hapus List', `admin:confirm_delete_group:${ctx.match[1]}`)],
    [Markup.button.callback('⬅️ Batal', 'admin:delete_group_menu')]
  ]));
});

bot.action(/^admin:confirm_delete_group:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const products = await getProducts();
  const groups = groupProducts(products);
  const group = groups[Number(ctx.match[1])];

  if (!group) {
    await ctx.answerCbQuery('List produk tidak ditemukan.');
    return;
  }

  const groupIds = new Set(group.products.map((product) => product.id));
  const filteredProducts = products.filter((product) => !groupIds.has(product.id));
  await writeJson(productsPath, filteredProducts);
  await ctx.answerCbQuery('List produk dihapus.');
  await editOrReply(ctx, `✅ List produk ${group.name} berhasil dihapus.`, adminProductMenu());
});

bot.action(/^admin:products_page:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const products = await getProducts();
  const page = Number(ctx.match[1]);
  adminSessions.set(ctx.from.id, { action: 'manage_products', page });
  await ctx.answerCbQuery('Memuat...');
  await replyMenu(
    ctx,
    adminProductListMessage(products, page),
    adminProductsKeyboard(products, page)
  );
});

bot.action('admin:list_products', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const products = await getProducts();
  await ctx.answerCbQuery();

  if (!products.length) {
    await replyClean(ctx, 'Belum ada produk.', adminProductMenu());
    return;
  }

  adminSessions.set(ctx.from.id, { action: 'manage_products', page: 0 });
  await replyMenu(
    ctx,
    adminProductListMessage(products),
    adminProductsKeyboard(products)
  );
});

bot.action(/^admin:show_product:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const products = await getProducts();
  const product = products.find((item) => item.id === ctx.match[1]);

  if (!product) {
    await ctx.answerCbQuery('Produk tidak ditemukan.');
    return;
  }

  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, productCard(product), productManageButtons(product.id));
});

bot.action(/^admin:edit_product:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const productId = ctx.match[1];
  const products = await getProducts();
  const product = products.find((item) => item.id === productId);

  if (!product) {
    await ctx.answerCbQuery('Produk tidak ditemukan.');
    return;
  }

  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['✏️ Ubah Data Produk', '', `${productIcon(product)} ${product.name}`, `💰 ${formatRupiah(product.price)}`, '', 'Pilih data yang ingin diubah.'].join('\n'), productEditButtons(productId));
});

bot.action(/^admin:edit_field:(name|price|description):(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const field = ctx.match[1];
  const productId = ctx.match[2];
  const labels = { name: 'nama produk', price: 'harga produk', description: 'deskripsi produk' };
  adminSessions.set(ctx.from.id, { action: 'edit_field', productId, field });
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, `Kirim ${labels[field]} baru.`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', `admin:edit_product:${productId}`)]]));
});

bot.action(/^admin:stock_menu:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const products = await getProducts();
  const product = products.find((item) => item.id === ctx.match[1]);

  if (!product) {
    await ctx.answerCbQuery('Produk tidak ditemukan.');
    return;
  }

  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, stockManageMessage(product), productStockButtons(product.id));
});

bot.action(/^admin:remove_stock:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const products = await getProducts();
  const product = products.find((item) => item.id === ctx.match[1]);

  if (!product) {
    await ctx.answerCbQuery('Produk tidak ditemukan.');
    return;
  }

  if (!product.stock.length) {
    await ctx.answerCbQuery('Stok sudah kosong.');
    return;
  }

  product.stock.pop();
  await writeJson(productsPath, products);
  await ctx.answerCbQuery('1 stok dikurangi.');
  await ctx.editMessageText(stockManageMessage(product), productStockButtons(product.id));
});

bot.action(/^admin:view_stock:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const products = await getProducts();
  const product = products.find((item) => item.id === ctx.match[1]);

  if (!product) {
    await ctx.answerCbQuery('Produk tidak ditemukan.');
    return;
  }

  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, [`📦 Stok ${product.name}`, '', formatStockList(product)].join('\n'), productStockButtons(product.id));
});

bot.action(/^admin:set_stock:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  adminSessions.set(ctx.from.id, { action: 'set_stock', productId: ctx.match[1] });
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['✏️ Update Data Stok', '', 'Copy list stok dari pesan sebelumnya, edit/hapus/tambah datanya, lalu kirim ulang ke bot.', '', 'Format:', '1. kamaludin@gmail.com|pajigur32', '2. kamfhin@gmail.com|jigur321', '', 'Boleh juga tanpa nomor:', 'kamaludin@gmail.com|pajigur32', '', 'Data lama akan diganti realtime dengan teks baru yang kamu kirim.'].join('\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', `admin:stock_menu:${ctx.match[1]}`)]]));
});

bot.action(/^admin:add_stock:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  adminSessions.set(ctx.from.id, { action: 'add_stock', productId: ctx.match[1] });
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, ['➕ Tambah Stok Baru', '', 'Kirim data akun/kode yang akan diberikan ke pembeli.', '', 'Format paling rapi: 1 stok per baris.', '', 'Contoh:', 'email1@gmail.com|password1', 'email2@gmail.com|password2', 'kode-voucher-123', '', 'Boleh juga dipisah koma jika banyak.'].join('\n'));
});

bot.action(/^admin:clear_stock:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const productId = ctx.match[1];
  const products = await getProducts();
  const product = products.find((item) => item.id === productId);

  if (!product) {
    await ctx.answerCbQuery('Produk tidak ditemukan.');
    return;
  }

  product.stock = [];
  await writeJson(productsPath, products);
  await ctx.answerCbQuery('Stok dihabiskan.');
  await ctx.editMessageText(`${productCard(product)}\n\n✅ Stok sudah dikosongkan.`);
});

bot.action(/^admin:delete_product:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const productId = ctx.match[1];
  await ctx.answerCbQuery('Memuat...');
  await editOrReply(ctx, 'Yakin hapus produk ini?', Markup.inlineKeyboard([
    Markup.button.callback('✅ Ya, Hapus', `admin:confirm_delete:${productId}`),
    Markup.button.callback('❌ Batal', 'admin:cancel')
  ]));
});

bot.action(/^admin:confirm_delete:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  const productId = ctx.match[1];
  const products = await getProducts();
  const filteredProducts = products.filter((item) => item.id !== productId);

  if (filteredProducts.length === products.length) {
    await ctx.answerCbQuery('Produk tidak ditemukan.');
    return;
  }

  await writeJson(productsPath, filteredProducts);
  await ctx.answerCbQuery('Produk dihapus.');
  await ctx.editMessageText('✅ Produk berhasil dihapus.');
});

bot.action('admin:cancel', async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery('Khusus admin.');
    return;
  }

  adminSessions.delete(ctx.from.id);
  await ctx.answerCbQuery('Dibatalkan.');
  await ctx.editMessageText('❌ Aksi dibatalkan.');
});

bot.on('text', async (ctx) => {
  if (!isAdmin(ctx)) {
    return;
  }

  const session = adminSessions.get(ctx.from.id);

  if (!session) {
    return;
  }

  const products = await getProducts();

  if (session.action === 'ban_user' || session.action === 'unban_user') {
    const userId = ctx.message.text.trim();

    if (!/^\d+$/.test(userId)) {
      await replyClean(ctx, 'ID user harus berupa angka.');
      return;
    }

    const settings = await getSettings();
    settings.bannedUsers = settings.bannedUsers || [];

    if (session.action === 'ban_user') {
      if (!settings.bannedUsers.includes(userId)) {
        settings.bannedUsers.push(userId);
      }

      await writeSettings(settings);
      adminSessions.delete(ctx.from.id);
      await replyClean(ctx, `✅ User ${userId} berhasil diban.`, adminProductMenu());
      return;
    }

    settings.bannedUsers = settings.bannedUsers.filter((item) => item !== userId);
    await writeSettings(settings);
    adminSessions.delete(ctx.from.id);
    await replyClean(ctx, `✅ User ${userId} berhasil di-unban.`, adminProductMenu());
    return;
  }

  if (session.action === 'broadcast') {
    const message = ctx.message.text.trim();

    if (!message) {
      await replyClean(ctx, 'Pesan broadcast tidak boleh kosong.');
      return;
    }

    const orders = await getOrders();
    const userIds = [...new Set(orders.map((order) => order.userId))];
    let sent = 0;

    for (const userId of userIds) {
      try {
        await ctx.telegram.sendMessage(userId, `📢 Info dari ${storeName}\n\n${message}`);
        sent += 1;
      } catch {}
    }

    adminSessions.delete(ctx.from.id);
    await replyClean(ctx, `✅ Broadcast terkirim ke ${sent} pembeli.`, adminProductMenu());
    return;
  }

  if (session.action === 'add_product_step') {
    const value = ctx.message.text.trim();

    if (!value) {
      await replyClean(ctx, 'Input tidak boleh kosong.');
      return;
    }

    if (session.step === 'groupName') {
      session.data.groupName = value.toUpperCase();
      session.step = 'name';
      adminSessions.set(ctx.from.id, session);
      await replyClean(ctx, ['Step 2/6', 'Kirim nama variasi/durasi pertama.', '', 'Contoh:', 'CapCut Pro 7 Hari'].join('\n'));
      return;
    }

    if (session.step === 'name') {
      session.data.name = value;
      session.step = 'price';
      adminSessions.set(ctx.from.id, session);
      await replyClean(ctx, [session.type === 'new' ? 'Step 3/6' : 'Step 2/4', 'Kirim harga produk angka saja.', '', 'Contoh:', '15000'].join('\n'));
      return;
    }

    if (session.step === 'price') {
      const price = Number(value.replace(/[^0-9]/g, ''));

      if (!price) {
        await replyClean(ctx, 'Harga harus berupa angka. Contoh: 15000');
        return;
      }

      session.data.price = price;
      session.step = 'description';
      adminSessions.set(ctx.from.id, session);
      await replyClean(ctx, [session.type === 'new' ? 'Step 4/6' : 'Step 3/4', 'Kirim deskripsi produk.', '', 'Contoh:', 'Akun privat, garansi 1 hari.'].join('\n'));
      return;
    }

    if (session.step === 'description') {
      session.data.description = value;

      if (session.type === 'variant') {
        session.step = 'stock';
        adminSessions.set(ctx.from.id, session);
        await replyClean(ctx, ['Step 4/4', 'Kirim stok produk.', 'Setiap baris = 1 stok.', '', 'Contoh:', 'email1@gmail.com|pass1', 'email2@gmail.com|pass2', '', 'Kalau stok belum ada, kirim: -'].join('\n'));
        return;
      }

      session.step = 'icon';
      adminSessions.set(ctx.from.id, session);
      await replyClean(ctx, ['Step 5/6', 'Kirim icon produk.', '', 'Contoh:', '🎬', '', 'Kalau tidak mau pakai icon, kirim: -'].join('\n'));
      return;
    }

    if (session.step === 'icon') {
      session.data.icon = value === '-' ? '🛍️' : value;
      session.step = 'stock';
      adminSessions.set(ctx.from.id, session);
      await replyClean(ctx, ['Step 6/6', 'Kirim stok produk.', 'Setiap baris = 1 stok.', '', 'Contoh:', 'email1@gmail.com|pass1', 'email2@gmail.com|pass2', '', 'Kalau stok belum ada, kirim: -'].join('\n'));
      return;
    }

    if (session.step === 'stock') {
      const stock = value === '-' ? [] : parseStockText(value);
      let id = createProductId(session.data.name);
      let index = 2;

      while (products.some((product) => product.id === id)) {
        id = `${createProductId(session.data.name)}-${index}`;
        index += 1;
      }

      const product = { id, name: session.data.name, groupName: session.data.groupName, icon: session.data.icon, price: session.data.price, description: session.data.description, stock };
      products.push(product);
      await writeJson(productsPath, products);
      adminSessions.delete(ctx.from.id);
      await replyClean(ctx, `✅ Produk berhasil ditambahkan.\n\n${productCard(product)}`, productManageButtons(product.id));
      return;
    }
  }

  if (session.action === 'edit_field') {
    const product = products.find((item) => item.id === session.productId);

    if (!product) {
      adminSessions.delete(ctx.from.id);
      await replyClean(ctx, 'Produk tidak ditemukan.');
      return;
    }

    const value = ctx.message.text.trim();

    if (!value) {
      await replyClean(ctx, 'Input tidak boleh kosong.');
      return;
    }

    if (session.field === 'price') {
      const price = Number(value.replace(/[^0-9]/g, ''));

      if (!price) {
        await replyClean(ctx, 'Harga harus berupa angka.');
        return;
      }

      product.price = price;
    }

    if (session.field === 'name') {
      product.name = value;
    }

    if (session.field === 'description') {
      product.description = value;
    }

    await writeJson(productsPath, products);
    adminSessions.delete(ctx.from.id);
    await replyClean(ctx, `✅ Produk berhasil diubah.\n\n${productCard(product)}`, productManageButtons(product.id));
    return;
  }

  if (session.action === 'edit_product') {
    const product = products.find((item) => item.id === session.productId);

    if (!product) {
      adminSessions.delete(ctx.from.id);
      await replyClean(ctx, 'Produk tidak ditemukan.');
      return;
    }

    const data = parseProductInput(ctx.message.text);
    const price = data.harga ? Number(data.harga) : product.price;
    product.name = data.nama || product.name;
    product.price = price || product.price;
    product.description = data.deskripsi || product.description;
    await writeJson(productsPath, products);
    adminSessions.delete(ctx.from.id);
    await replyClean(ctx, `✅ Produk berhasil diubah.\n\n${productCard(product)}`, productManageButtons(product.id));
    return;
  }

  if (session.action === 'set_stock') {
    const product = products.find((item) => item.id === session.productId);

    if (!product) {
      adminSessions.delete(ctx.from.id);
      await replyClean(ctx, 'Produk tidak ditemukan.');
      return;
    }

    product.stock = parseStockText(ctx.message.text);
    await writeJson(productsPath, products);
    adminSessions.delete(ctx.from.id);
    await replyClean(ctx, [`✅ Data stok berhasil diupdate.`, '', stockManageMessage(product)].join('\n'), productStockButtons(product.id));
    return;
  }

  if (session.action === 'add_stock') {
    const product = products.find((item) => item.id === session.productId);

    if (!product) {
      adminSessions.delete(ctx.from.id);
      await replyClean(ctx, 'Produk tidak ditemukan.');
      return;
    }

    const stock = parseStockText(ctx.message.text);

    if (!stock.length) {
      await replyClean(ctx, 'Stok kosong. Kirim stok minimal 1 item.');
      return;
    }

    product.stock.push(...stock);
    await writeJson(productsPath, products);
    adminSessions.delete(ctx.from.id);
    await replyClean(ctx, [`✅ ${stock.length} stok berhasil ditambahkan.`, '', productCard(product), '', '📦 List stok:', formatStockList(product)].join('\n'), productStockButtons(product.id));
  }
});

if (require.main === module) {
  bot.launch();
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

module.exports = bot;
