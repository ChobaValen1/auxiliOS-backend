'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DNI_RE = /^\d{6,10}$/;
const ROLE_NAMES = new Set(['administracion', 'supervision', 'chofer']);

function normalizedString(value, { min = 1, max = 255, uppercase = false } = {}) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (clean.length < min || clean.length > max) return null;
  return uppercase ? clean.toUpperCase() : clean;
}

function validateDniLogin(body = {}) {
  const dni = normalizedString(body.dni, { min: 6, max: 10 });
  const password = typeof body.password === 'string' ? body.password : '';
  if (!dni || !DNI_RE.test(dni) || password.length < 1 || password.length > 256) {
    return { ok: false, error: 'Credenciales inválidas' };
  }
  return { ok: true, value: { dni, password } };
}

function validateCreateUser(body = {}) {
  const fullName = normalizedString(body.full_name, { min: 2, max: 120 });
  const email = normalizedString(body.email, { min: 5, max: 254 });
  const legajo = normalizedString(body.legajo, { min: 1, max: 40, uppercase: true });
  const roleName = normalizedString(body.role_name, { min: 1, max: 40 });
  const phone = body.phone == null || body.phone === ''
    ? null
    : normalizedString(body.phone, { min: 6, max: 30 });
  const dni = body.dni == null || body.dni === ''
    ? null
    : normalizedString(body.dni, { min: 6, max: 10 });

  if (!fullName || !email || !EMAIL_RE.test(email) || !legajo || !ROLE_NAMES.has(roleName)) {
    return { ok: false, error: 'Datos de usuario inválidos' };
  }
  if (body.phone && !phone) return { ok: false, error: 'Teléfono inválido' };
  if (dni && !DNI_RE.test(dni)) return { ok: false, error: 'DNI inválido' };

  return {
    ok: true,
    value: {
      full_name: fullName,
      email: email.toLowerCase(),
      legajo,
      role_name: roleName,
      phone,
      dni,
    },
  };
}

function validateUserId(body = {}) {
  const userId = normalizedString(body.userId, { min: 20, max: 80 });
  if (!userId) return { ok: false, error: 'Usuario inválido' };
  return { ok: true, value: { userId } };
}

module.exports = {
  validateCreateUser,
  validateDniLogin,
  validateUserId,
};
