function ok(res, data = null, message = 'ok') {
  res.json({ code: 0, message, data });
}

function fail(res, message = '业务错误', status = 200, code = 1) {
  res.status(status).json({ code, message, data: null });
}

function unauthorized(res, message = '登录已过期') {
  res.status(401).json({ code: 401, message, data: null });
}

module.exports = { ok, fail, unauthorized };