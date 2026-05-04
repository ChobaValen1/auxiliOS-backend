require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
const port = process.env.PORT || 3000;



const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://REEMPLAZAR-CON-DOMINIO.vercel.app',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS: origen no permitido'));
  }
}));
app.use(express.json({ limit: '15mb' }));

// Exponer la carpeta uploads para que el frontend pueda ver las firmas y fotos
app.use('/uploads', express.static('uploads'));

// ── LECTOR DE TICKETS OCR con GPT-4o-mini ──────────────────────────────
app.post('/api/leer-ticket', async (req, res) => {
  const { imagen_base64 } = req.body;
  if (!imagen_base64) return res.status(400).json({ error: 'Falta imagen_base64' });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY no configurada en .env' });
  }

  const prompt = `Analizá este ticket de combustible argentino y extraé los datos.
Respondé ÚNICAMENTE con un JSON válido, sin markdown ni texto adicional, con esta estructura:
{
  "litros": número_o_null,
  "precio_por_litro": número_o_null,
  "total": número_o_null,
  "estacion": "nombre específico de la estación de servicio incluyendo su dirección, calle o kilómetro si aparece (por ejemplo: 'YPF Av. Mitre 1240' o 'Shell Ruta 3 km 52'). NO pongas solo la marca como 'YPF' o 'Shell'. Si no hay dirección, incluí al menos el nombre del local o sucursal. null si no aparece.",
  "km": número_o_null,
  "fecha": "fecha de la operación en formato YYYY-MM-DD, null si no aparece",
  "patente": "patente o dominio del vehículo si aparece en el ticket, null si no aparece",
  "metodo_pago": "efectivo" o "transferencia" o "tarjeta" o null
}
Si no podés leer un campo con certeza, poné null.`;

  const requestBody = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imagen_base64}`, detail: 'high' } }
      ]
    }],
    max_tokens: 300,
  });

  try {
    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Length': Buffer.byteLength(requestBody),
        },
      };

      const req = https.request(options, (apiRes) => {
        let raw = '';
        apiRes.on('data', chunk => { raw += chunk; });
        apiRes.on('end', () => {
          if (apiRes.statusCode !== 200) {
            reject(new Error(`OpenAI HTTP ${apiRes.statusCode}: ${raw}`));
          } else {
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error('Respuesta inválida de OpenAI')); }
          }
        });
      });

      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return res.status(500).json({ error: 'Sin respuesta de GPT' });

    // Limpiar posible markdown ```json ... ```
    const clean = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (err) {
    console.error('Error leer-ticket:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 1. CONEXIÓN A TU BASE DE DATOS POSTGRESQL
// Reemplaza estas credenciales con las tuyas reales (usa variables de entorno para mayor seguridad, especialmente para la contraseña)
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'sigma_remolques', // El nombre de tu base de datos PostgreSQL (reemplaza con el nombre real de tu base de datos)
  password: "", // Tu contraseña de PostgreSQL (recomienda usar variables de entorno para seguridad)
  port: 5432,
});

// 2. MOTOR DE ARCHIVOS (Multer) - Configuración para guardar las imágenes en el servidor
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/remitos';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'));
  }
});
const upload = multer({ storage: storage });

// 3. ENDPOINT TRANSACCIONAL - Recibe el remito firmado, guarda las imágenes y luego inserta todo en PostgreSQL
app.post('/api/nuevo-remito', upload.any(), async (req, res) => {
  // Inicializamos un cliente dedicado para manejar la transacción de forma segura y evitar conflictos con otras solicitudes concurrentes
  const client = await pool.connect();
  
  try {
    console.log(`📥 Procesando remito: ${req.body.remito_nro}`);

    // A. Recolectar las rutas de los archivos subidos y formatearlas para la base de datos
    let firmaUrl = null;
    let fotoUrls = [];
    
    if (req.files) {
      req.files.forEach(file => {
        // Formateamos la ruta para guardarla en la base de datos (la ruta relativa desde la raíz del servidor, no la absoluta del sistema de archivos)   
        const dbPath = `/uploads/remitos/${file.filename}`;
        if (file.fieldname === 'firma_cliente') {
          firmaUrl = dbPath;
        } else if (file.fieldname.startsWith('foto_')) {
          fotoUrls.push(dbPath);
        }
      });
    }
    
    // B. Mapeo de booleanos (Asegurado)
    const confirmaciones = JSON.parse(req.body.confirmaciones || '[]');
    const conformidad_servicio = confirmaciones.includes("Conformidad con el servicio");
    const conformidad_cargos = confirmaciones.includes("Aceptación de cargos variables");
    const sin_danos = confirmaciones.includes("Sin daños reportados");
    const conformidad_arrastre = confirmaciones.includes("Conformidad de Arrastre");

    // Iniciamos la transacción SQL (Una sola vez, después de mapear las variables)
    await client.query('BEGIN');   

    // C. INYECCIÓN SQL (El Embudo Ancho)
    const insertQuery = `
      INSERT INTO remitos (
        nro_servicio, patente, marca_modelo, razon_social, cuit, 
        tipo_servicio, origen, destino, km_reales, 
        imp_peaje, imp_excedente, imp_otros, 
        pago_1_metodo, foto_urls, firma_imagen_url, 
        conformidad_servicio, conformidad_cargos, sin_danos, conformidad_arrastre,
        status, firmado_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW()
      ) RETURNING remito_id, nro_remito;
    `;

    const values = [
      req.body.nro_servicio || null,
      req.body.patente || null,
      req.body.marca_modelo || null,
      req.body.cliente_razon_social || null,
      req.body.cliente_cuit || null,
      req.body.tipo_servicio || null,
      req.body.origen || null,
      req.body.destino || null,
      req.body.km_recorridos || 0,
      req.body.peaje || 0,
      req.body.excedente || 0,
      req.body.otros_cargos || 0,
      req.body.metodo_pago === 'Pendiente' ? null : (req.body.metodo_pago ? req.body.metodo_pago.toLowerCase() : null),
      fotoUrls,
      firmaUrl,
      conformidad_servicio,
      conformidad_cargos,
      sin_danos,
      conformidad_arrastre,
      'firmado'
    ];


    const result = await client.query(insertQuery, values);
    
    // Confirmamos la transacción (esto hace que todos los cambios se guarden definitivamente en la base de datos, si algo hubiera fallado antes de este punto, no se guardaría nada)
    await client.query('COMMIT');
    
    console.log(`✅ Remito insertado exitosamente con ID: ${result.rows[0].remito_id}`);
    res.status(200).json({ status: "success", message: "Remito archivado en PostgreSQL." });

  } catch (error) {
    // Si algo falló (por ejemplo, faltó un dato obligatorio en la BD), revertimos todo para mantener la integridad de los datos (esto asegura que no se guarde información incompleta o corrupta en la base de datos)
    await client.query('ROLLBACK');
    console.error("❌ Fallo en la transacción de base de datos:", error);
    res.status(500).json({ status: "error", message: error.message });
  } finally {
    // Liberamos el cliente para no saturar la memoria del servidor y permitir que otros procesos puedan usarlo (esto es crucial para manejar múltiples solicitudes concurrentes sin bloquear el servidor)
    client.release();
  }
});

   // 4. ENDPOINT DE LECTURA - Extrae el historial de remitos para visualizar en la tabla
app.get('/api/remitos', async (req, res) => {
  try {
    // Hacemos una consulta directa. Ordenamos por fecha de firma descendente.
    // Limitamos a 50 para no colapsar la memoria si la tabla crece masivamente.
    const query = `
      SELECT 
        remito_id, nro_remito, patente, razon_social, 
        tipo_servicio, origen, destino, firmado_at, status 
      FROM remitos 
      ORDER BY firmado_at DESC 
      LIMIT 50;
    `;
    
    const result = await pool.query(query);
    
    // Le enviamos al frontend el array de datos limpio
    res.status(200).json(result.rows);
    
  } catch (error) {
    console.error("❌ Fallo al extraer los remitos:", error);
    res.status(500).json({ status: "error", message: "Error leyendo la base de datos" });
  }
});
// 5. ENDPOINT DE DETALLE - Extrae TODA la información de un remito específico
app.get('/api/remitos/:id', async (req, res) => {
  try {
    const remitoId = req.params.id; // Capturamos el ID que viene en la URL
    
    // Aquí sí hacemos un SELECT * porque necesitamos la firma, fotos y dinero
    const query = `SELECT * FROM remitos WHERE remito_id = $1`;
    const result = await pool.query(query, [remitoId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ status: "error", message: "Remito no encontrado" });
    }
    
    res.status(200).json(result.rows[0]); // Devolvemos el objeto único, no un array
  } catch (error) {
    console.error("❌ Fallo al extraer el detalle:", error);
    res.status(500).json({ status: "error", message: "Error leyendo la base de datos" });
  }
});

// ── CREAR USUARIO (Supabase Auth + tabla users) ────────────────
const ROLE_IDS = { administracion: 1, supervision: 2, chofer: 3 };

app.post('/api/create-user', async (req, res) => {
  const { full_name, email, legajo, role_name, phone } = req.body;
  if (!full_name || !email || !legajo || !role_name)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });

  const role_id = ROLE_IDS[role_name];
  if (!role_id) return res.status(400).json({ error: 'Rol inválido' });

  // 1. Crear cuenta en Supabase Auth
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: 'Sigma1234!',
    email_confirm: true,
    user_metadata: { full_name },
  });
  if (authErr) return res.status(400).json({ error: authErr.message });

  const user_id = authData.user.id;

  // 2. Insertar perfil en tabla users con el UUID de Auth
  const { error: dbErr } = await supabaseAdmin
    .from('users')
    .insert({ user_id, role_id, legajo, email, full_name, phone: phone || null });

  if (dbErr) {
    // Revertir cuenta Auth si falla el perfil
    await supabaseAdmin.auth.admin.deleteUser(user_id);
    return res.status(500).json({ error: dbErr.message });
  }

  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Servidor Node.js conectado a PostgreSQL operativo en el puerto ${port}`);
});