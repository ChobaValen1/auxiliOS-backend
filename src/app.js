'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { createAuthMiddleware } = require('./auth');
const { validateCreateUser, validateDniLogin, validateUserId } = require('./validation');

const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
]);

function makeLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: message },
  });
}

function createUpload(config) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, config.uploadDir),
    filename: (_req, file, callback) => {
      const extension = ALLOWED_IMAGE_TYPES.get(file.mimetype);
      callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: config.maxUploadBytes,
      files: config.maxUploadFiles,
      fields: 60,
    },
    fileFilter: (_req, file, callback) => {
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        const error = new Error('Solo se permiten imágenes JPEG, PNG, WEBP, HEIC o HEIF');
        error.code = 'INVALID_FILE_TYPE';
        return callback(error);
      }
      return callback(null, true);
    },
  });
}

function cleanUploadedFiles(files = []) {
  for (const file of files) {
    fs.promises.unlink(file.path).catch(() => {});
  }
}

function requireLegacyDatabase(pool) {
  return (_req, res, next) => {
    if (!pool) return res.status(503).json({ error: 'Módulo PostgreSQL legado no configurado' });
    return next();
  };
}

function createApp({ config, supabaseAdmin, createSupabasePublicClient, pool, logger = console }) {
  if (!config || !supabaseAdmin || !createSupabasePublicClient) {
    throw new Error('Faltan dependencias requeridas para crear la aplicación');
  }

  const app = express();
  const { requireAuth, requireRoles } = createAuthMiddleware(supabaseAdmin);
  const upload = createUpload(config);
  const legacyDb = requireLegacyDatabase(pool);

  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
      const error = new Error('Origen no permitido');
      error.status = 403;
      return callback(error);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    maxAge: 600,
  }));
  app.use(express.json({ limit: config.jsonLimit, type: 'application/json' }));

  app.use((req, res, next) => {
    const incomingId = req.get('X-Request-Id');
    const requestId = incomingId && /^[a-zA-Z0-9._-]{8,100}$/.test(incomingId)
      ? incomingId
      : crypto.randomUUID();
    const startedAt = Date.now();
    req.requestId = requestId;
    req.log = (level, event, fields = {}) => logger[level]?.(JSON.stringify({
      level,
      event,
      requestId,
      ...fields,
    }));
    res.set('X-Request-Id', requestId);
    res.on('finish', () => req.log('info', 'http_request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      actorId: req.auth?.user?.id || null,
    }));
    next();
  });

  app.use(makeLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    message: 'Demasiadas solicitudes. Intentá nuevamente más tarde.',
  }));

  const loginLimiter = makeLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: 'Demasiados intentos de acceso. Intentá nuevamente en 15 minutos.',
  });
  const adminWriteLimiter = makeLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    message: 'Demasiadas operaciones administrativas. Intentá nuevamente más tarde.',
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'auxilios-backend' });
  });

  // Autentica DNI + contraseña sin revelar el email asociado al DNI.
  app.post('/api/login-by-dni', loginLimiter, async (req, res) => {
    const parsed = validateDniLogin(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    try {
      const { data: profile, error: lookupError } = await supabaseAdmin
        .from('users')
        .select('email, is_active')
        .eq('dni', parsed.value.dni)
        .maybeSingle();

      if (lookupError || !profile?.email || profile.is_active === false) {
        return res.status(401).json({ error: 'DNI o contraseña incorrectos' });
      }

      const supabasePublic = createSupabasePublicClient();
      const { data, error } = await supabasePublic.auth.signInWithPassword({
        email: profile.email,
        password: parsed.value.password,
      });

      if (error || !data?.session) {
        return res.status(401).json({ error: 'DNI o contraseña incorrectos' });
      }

      return res.json({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      });
    } catch (error) {
      req.log('error', 'dni_login_failed', { message: error.message });
      return res.status(500).json({ error: 'No se pudo iniciar sesión' });
    }
  });

  app.post('/api/leer-ticket', requireAuth, async (req, res) => {
    const imagenBase64 = typeof req.body?.imagen_base64 === 'string' ? req.body.imagen_base64 : '';
    if (!imagenBase64 || imagenBase64.length > 7_000_000) {
      return res.status(400).json({ error: 'Imagen inválida o demasiado grande' });
    }
    if (!config.openaiApiKey) {
      return res.status(503).json({ error: 'Servicio OCR no configurado' });
    }

    const prompt = `Analizá este ticket de combustible argentino y extraé los datos. Respondé únicamente con JSON válido con las claves litros, precio_por_litro, total, estacion, km, fecha, patente y metodo_pago. Usá null cuando un campo no sea legible.`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45_000);
      const apiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openaiApiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imagenBase64}`, detail: 'high' } },
            ],
          }],
          max_tokens: 300,
          response_format: { type: 'json_object' },
        }),
      }).finally(() => clearTimeout(timeout));

      if (!apiResponse.ok) {
        req.log('error', 'openai_http_error', { status: apiResponse.status });
        return res.status(502).json({ error: 'El servicio OCR no respondió correctamente' });
      }
      const data = await apiResponse.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) return res.status(502).json({ error: 'Respuesta OCR vacía' });
      return res.json(JSON.parse(content));
    } catch (error) {
      req.log('error', 'ticket_ocr_failed', { message: error.message });
      return res.status(502).json({ error: 'No se pudo procesar el ticket' });
    }
  });

  // API PostgreSQL heredada: queda autenticada mientras se migra todo a Supabase.
  app.post(
    '/api/nuevo-remito',
    requireAuth,
    requireRoles('administracion', 'supervision', 'chofer'),
    legacyDb,
    upload.any(),
    async (req, res) => {
      let client;
      try {
        client = await pool.connect();
        const confirmaciones = JSON.parse(req.body.confirmaciones || '[]');
        if (!Array.isArray(confirmaciones)) throw new Error('Confirmaciones inválidas');

        let firmaUrl = null;
        const fotoUrls = [];
        for (const file of req.files || []) {
          const dbPath = `/uploads/remitos/${file.filename}`;
          if (file.fieldname === 'firma_cliente') firmaUrl = dbPath;
          else if (file.fieldname.startsWith('foto_')) fotoUrls.push(dbPath);
        }

        await client.query('BEGIN');
        const result = await client.query(`
          INSERT INTO remitos (
            nro_servicio, patente, marca_modelo, razon_social, cuit,
            tipo_servicio, origen, destino, km_reales,
            imp_peaje, imp_excedente, imp_otros,
            pago_1_metodo, foto_urls, firma_imagen_url,
            conformidad_servicio, conformidad_cargos, sin_danos, conformidad_arrastre,
            status, firmado_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, 'firmado', NOW()
          ) RETURNING remito_id, nro_remito
        `, [
          req.body.nro_servicio || null,
          req.body.patente || null,
          req.body.marca_modelo || null,
          req.body.cliente_razon_social || null,
          req.body.cliente_cuit || null,
          req.body.tipo_servicio || null,
          req.body.origen || null,
          req.body.destino || null,
          Number(req.body.km_recorridos) || 0,
          Number(req.body.peaje) || 0,
          Number(req.body.excedente) || 0,
          Number(req.body.otros_cargos) || 0,
          req.body.metodo_pago === 'Pendiente' ? null : req.body.metodo_pago?.toLowerCase() || null,
          fotoUrls,
          firmaUrl,
          confirmaciones.includes('Conformidad con el servicio'),
          confirmaciones.includes('Aceptación de cargos variables'),
          confirmaciones.includes('Sin daños reportados'),
          confirmaciones.includes('Conformidad de Arrastre'),
        ]);
        await client.query('COMMIT');
        req.log('info', 'legacy_remito_created', { remitoId: result.rows[0].remito_id });
        return res.status(201).json({ ok: true, remito_id: result.rows[0].remito_id });
      } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        cleanUploadedFiles(req.files);
        req.log('error', 'legacy_remito_create_failed', { message: error.message });
        return res.status(500).json({ error: 'No se pudo guardar el remito' });
      } finally {
        client?.release();
      }
    }
  );

  app.get(
    '/api/remitos',
    requireAuth,
    requireRoles('administracion', 'supervision'),
    legacyDb,
    async (req, res) => {
      try {
        const result = await pool.query(`
          SELECT remito_id, nro_remito, patente, razon_social,
                 tipo_servicio, origen, destino, firmado_at, status
          FROM remitos ORDER BY firmado_at DESC LIMIT 50
        `);
        return res.json(result.rows);
      } catch (error) {
        req.log('error', 'legacy_remitos_read_failed', { message: error.message });
        return res.status(500).json({ error: 'No se pudieron leer los remitos' });
      }
    }
  );

  app.get(
    '/api/remitos/:id',
    requireAuth,
    requireRoles('administracion', 'supervision'),
    legacyDb,
    async (req, res) => {
      try {
        const result = await pool.query('SELECT * FROM remitos WHERE remito_id = $1', [req.params.id]);
        if (!result.rows.length) return res.status(404).json({ error: 'Remito no encontrado' });
        return res.json(result.rows[0]);
      } catch (error) {
        req.log('error', 'legacy_remito_detail_failed', { message: error.message });
        return res.status(500).json({ error: 'No se pudo leer el remito' });
      }
    }
  );

  app.get(
    '/uploads/remitos/:filename',
    requireAuth,
    requireRoles('administracion', 'supervision'),
    (req, res) => {
      if (!/^[a-zA-Z0-9._-]+$/.test(req.params.filename)) {
        return res.status(400).json({ error: 'Archivo inválido' });
      }
      const filePath = path.join(config.uploadDir, req.params.filename);
      return res.sendFile(filePath, (error) => {
        if (error && !res.headersSent) res.status(404).json({ error: 'Archivo no encontrado' });
      });
    }
  );

  app.post(
    '/api/create-user',
    adminWriteLimiter,
    requireAuth,
    requireRoles('administracion'),
    async (req, res) => {
      const parsed = validateCreateUser(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const input = parsed.value;

      try {
        const { data: role, error: roleError } = await supabaseAdmin
          .from('roles')
          .select('role_id')
          .eq('name', input.role_name)
          .single();
        if (roleError || !role?.role_id) {
          req.log('error', 'role_lookup_failed', { role: input.role_name });
          return res.status(500).json({ error: 'No se pudo validar el rol solicitado' });
        }

        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
          input.email,
          {
            redirectTo: config.passwordResetRedirect,
            data: { full_name: input.full_name },
          }
        );
        if (authError || !authData?.user) {
          req.log('warn', 'user_invitation_failed', { message: authError?.message });
          return res.status(400).json({ error: 'No se pudo invitar al usuario' });
        }

        const userId = authData.user.id;
        const { error: profileError } = await supabaseAdmin.from('users').insert({
          user_id: userId,
          role_id: role.role_id,
          legajo: input.legajo,
          email: input.email,
          full_name: input.full_name,
          phone: input.phone,
          dni: input.dni,
          password_hash: 'SUPABASE_AUTH',
        });

        if (profileError) {
          await supabaseAdmin.auth.admin.deleteUser(userId);
          req.log('error', 'user_profile_create_failed', { message: profileError.message });
          return res.status(500).json({ error: 'No se pudo completar el alta del usuario' });
        }

        req.log('info', 'user_invited', { targetUserId: userId, role: input.role_name });
        return res.status(201).json({ ok: true, invitation_sent: true });
      } catch (error) {
        req.log('error', 'user_create_failed', { message: error.message });
        return res.status(500).json({ error: 'No se pudo crear el usuario' });
      }
    }
  );

  app.post(
    '/api/send-password-reset',
    adminWriteLimiter,
    requireAuth,
    requireRoles('administracion'),
    async (req, res) => {
      const parsed = validateUserId(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      try {
        const { data: profile, error: profileError } = await supabaseAdmin
          .from('users')
          .select('email')
          .eq('user_id', parsed.value.userId)
          .single();
        if (profileError || !profile?.email) return res.status(404).json({ error: 'Usuario no encontrado' });

        const supabasePublic = createSupabasePublicClient();
        const { error } = await supabasePublic.auth.resetPasswordForEmail(profile.email, {
          redirectTo: config.passwordResetRedirect,
        });
        if (error) {
          req.log('error', 'password_reset_email_failed', { message: error.message });
          return res.status(502).json({ error: 'No se pudo enviar el correo de recuperación' });
        }

        req.log('info', 'password_reset_requested', { targetUserId: parsed.value.userId });
        return res.json({ ok: true });
      } catch (error) {
        req.log('error', 'password_reset_failed', { message: error.message });
        return res.status(500).json({ error: 'No se pudo iniciar la recuperación' });
      }
    }
  );

  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  app.use((error, req, res, _next) => {
    cleanUploadedFiles(req.files);
    req.log?.('error', 'unhandled_request_error', { code: error.code, message: error.message });
    if (error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json({ error: 'La carga supera el límite permitido' });
    }
    if (error.code === 'INVALID_FILE_TYPE') {
      return res.status(415).json({ error: error.message });
    }
    return res.status(error.status || 500).json({
      error: error.status === 403 ? 'Origen no permitido' : 'Error interno del servidor',
    });
  });

  return app;
}

module.exports = { createApp };
