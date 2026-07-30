'use strict';

const path = require('path');

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Variable de entorno requerida: ${name}`);
  return value;
}

function integer(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

function list(raw, fallback) {
  if (!raw) return fallback;
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  const databaseUrl = env.DATABASE_URL?.trim();
  const pgHost = env.PGHOST?.trim();
  const databaseEnabled = Boolean(databaseUrl || pgHost);

  const poolOptions = databaseUrl
    ? {
        connectionString: databaseUrl,
        ssl: env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
      }
    : {
        host: pgHost,
        port: integer(env, 'PGPORT', 5432, { max: 65535 }),
        database: env.PGDATABASE?.trim(),
        user: env.PGUSER?.trim(),
        password: env.PGPASSWORD,
      };

  return {
    env: env.NODE_ENV || 'development',
    port: integer(env, 'PORT', 3000, { max: 65535 }),
    trustProxy: env.TRUST_PROXY === 'true' ? 1 : false,
    allowedOrigins: list(env.ALLOWED_ORIGINS, [
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'https://auxilios-arg.vercel.app',
    ]),
    jsonLimit: env.JSON_LIMIT || '5mb',
    uploadDir: path.resolve(env.UPLOAD_DIR || 'uploads/remitos'),
    maxUploadBytes: integer(env, 'MAX_UPLOAD_BYTES', 8 * 1024 * 1024),
    maxUploadFiles: integer(env, 'MAX_UPLOAD_FILES', 7, { max: 20 }),
    passwordResetRedirect: env.PASSWORD_RESET_REDIRECT?.trim() || 'https://auxilios-arg.vercel.app',
    supabase: {
      url: required(env, 'SUPABASE_URL'),
      serviceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
      anonKey: required(env, 'SUPABASE_ANON_KEY'),
    },
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    database: {
      enabled: databaseEnabled,
      poolOptions,
    },
  };
}

module.exports = { loadConfig };
