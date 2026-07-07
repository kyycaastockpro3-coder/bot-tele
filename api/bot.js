const bot = require('../src/index');

module.exports = async (request, response) => {
  if (request.method === 'GET') {
    response.status(200).json({ ok: true, message: 'Bot webhook aktif' });
    return;
  }

  if (request.method !== 'POST') {
    response.status(405).json({ ok: false, message: 'Method tidak diizinkan' });
    return;
  }

  try {
    await bot.handleUpdate(request.body);
    response.status(200).json({ ok: true });
  } catch (error) {
    response.status(500).json({ ok: false, message: error.message });
  }
};
