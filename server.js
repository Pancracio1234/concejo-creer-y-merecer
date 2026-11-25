const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');


const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de conexión a PostgreSQL (Neon en producción / local como respaldo)
const isProduction = Boolean(process.env.DATABASE_URL);

const pool = new Pool(
  isProduction
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false,
        },
      }
    : {
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'Concejo_Estudiantil',
        password: process.env.DB_PASSWORD || 'postgres',
        port: process.env.DB_PORT || 5432,
      }
);

// Verificar conexión al iniciar
pool
  .connect()
  .then((client) => {
    console.log('✅ Conectado exitosamente a PostgreSQL');
    client.release();
  })
  .catch((err) => {
    console.error('❌ ERROR DE CONEXIÓN A POSTGRESQL:', err.message);
  });

// ==========================================
// RUTAS DE CONSULTA GENERAL (BANCADAS, COMISIONES, INTEGRANTES)
// ==========================================

app.get('/api/bancadas', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bancadas ORDER BY id_bancada ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener bancadas:', err);
    res.status(500).json({ error: 'Error al obtener bancadas' });
  }
});

app.get('/api/comisiones', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM comisiones ORDER BY id_comision ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener comisiones:', err);
    res.status(500).json({ error: 'Error al obtener comisiones' });
  }
});

app.get('/api/integrantes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        i.id_integrante,
        i.nombre_completo,
        i.id_comision,
        i.id_bancada,
        i.es_directiva,
        i.cargo_directiva,
        b.nombre_bancada,
        b.color_hex,
        c.nombre_comision
      FROM integrantes i
      LEFT JOIN bancadas b ON i.id_bancada = b.id_bancada
      LEFT JOIN comisiones c ON i.id_comision = c.id_comision
      ORDER BY i.id_integrante ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener integrantes:', err);
    res.status(500).json({ error: 'Error al obtener integrantes' });
  }
});

// ==========================================
// RUTAS DE SESIONES Y LLAMADO A LISTA (ASISTENCIAS)
// ==========================================

app.get('/api/sesiones', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sesiones ORDER BY id_sesion DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener sesiones:', err);
    res.status(500).json({ error: 'Error al obtener sesiones' });
  }
});

app.post('/api/sesiones', async (req, res) => {
  const { titulo, tipo_sesion, fecha, id_comision, estado } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO sesiones (titulo, tipo_sesion, fecha, id_comision, estado)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, COALESCE($5, 'Activa'))
       RETURNING *`,
      [titulo, tipo_sesion || 'Plenaria', fecha || null, id_comision || null, estado]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error al crear sesión:', err);
    res.status(500).json({ error: 'Error al crear sesión' });
  }
});

app.get('/api/asistencias/:id_sesion', async (req, res) => {
  const { id_sesion } = req.params;
  try {
    const result = await pool.query(
      `SELECT a.*, i.nombre_completo, b.nombre_bancada, c.nombre_comision
       FROM asistencias a
       JOIN integrantes i ON a.id_integrante = i.id_integrante
       LEFT JOIN bancadas b ON i.id_bancada = b.id_bancada
       LEFT JOIN comisiones c ON i.id_comision = c.id_comision
       WHERE a.id_sesion = $1
       ORDER BY i.id_integrante ASC`,
      [id_sesion]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener asistencias:', err);
    res.status(500).json({ error: 'Error al obtener asistencias' });
  }
});

app.post('/api/asistencias', async (req, res) => {
  const { id_sesion, id_integrante, estado_asistencia, observaciones } = req.body;
  try {
    const existente = await pool.query(
      'SELECT id_asistencia FROM asistencias WHERE id_sesion = $1 AND id_integrante = $2',
      [id_sesion, id_integrante]
    );

    if (existente.rows.length > 0) {
      const updated = await pool.query(
        `UPDATE asistencias
         SET estado_asistencia = $1, observaciones = $2, hora_registro = CURRENT_TIME
         WHERE id_sesion = $3 AND id_integrante = $4
         RETURNING *`,
        [estado_asistencia, observaciones || null, id_sesion, id_integrante]
      );
      return res.json(updated.rows[0]);
    }

    const inserted = await pool.query(
      `INSERT INTO asistencias (id_sesion, id_integrante, estado_asistencia, observaciones, hora_registro)
       VALUES ($1, $2, $3, $4, CURRENT_TIME)
       RETURNING *`,
      [id_sesion, id_integrante, estado_asistencia, observaciones || null]
    );
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    console.error('Error al registrar asistencia:', err);
    res.status(500).json({ error: 'Error al registrar asistencia' });
  }
});

// ==========================================
// RUTAS DE INTERVENCIONES (CONTROL DE TIEMPOS)
// ==========================================

app.get('/api/intervenciones', async (req, res) => {
  const { id_sesion } = req.query;
  try {
    const query = id_sesion
      ? `SELECT iv.*, i.nombre_completo, b.nombre_bancada
         FROM intervenciones iv
         JOIN integrantes i ON iv.id_integrante = i.id_integrante
         LEFT JOIN bancadas b ON i.id_bancada = b.id_bancada
         WHERE iv.id_sesion = $1
         ORDER BY iv.id_intervencion DESC`
      : `SELECT iv.*, i.nombre_completo, b.nombre_bancada
         FROM intervenciones iv
         JOIN integrantes i ON iv.id_integrante = i.id_integrante
         LEFT JOIN bancadas b ON i.id_bancada = b.id_bancada
         ORDER BY iv.id_intervencion DESC`;

    const result = id_sesion ? await pool.query(query, [id_sesion]) : await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener intervenciones:', err);
    res.status(500).json({ error: 'Error al obtener intervenciones' });
  }
});

app.post('/api/intervenciones', async (req, res) => {
  const { id_sesion, id_integrante, tipo_intervencion, tiempo_asignado_seg, tiempo_usado_seg } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO intervenciones (id_sesion, id_integrante, tipo_intervencion, tiempo_asignado_seg, tiempo_usado_seg)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id_sesion || null, id_integrante, tipo_intervencion || 'Ordinaria', tiempo_asignado_seg || 180, tiempo_usado_seg || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error al registrar intervención:', err);
    res.status(500).json({ error: 'Error al registrar intervención' });
  }
});

// ==========================================
// RUTAS DE PROYECTOS Y DOCUMENTOS RADICADOS
// ==========================================

app.get('/api/proyectos', async (req, res) => {
  const { id_comision } = req.query;
  try {
    const query = id_comision
      ? `SELECT p.*, c.nombre_comision, b.nombre_bancada, i.nombre_completo AS autor_nombre
         FROM proyectos p
         LEFT JOIN comisiones c ON p.id_comision = c.id_comision
         LEFT JOIN bancadas b ON p.id_bancada = b.id_bancada
         LEFT JOIN integrantes i ON p.id_autor = i.id_integrante
         WHERE p.id_comision = $1
         ORDER BY p.id_proyecto DESC`
      : `SELECT p.*, c.nombre_comision, b.nombre_bancada, i.nombre_completo AS autor_nombre
         FROM proyectos p
         LEFT JOIN comisiones c ON p.id_comision = c.id_comision
         LEFT JOIN bancadas b ON p.id_bancada = b.id_bancada
         LEFT JOIN integrantes i ON p.id_autor = i.id_integrante
         ORDER BY p.id_proyecto DESC`;

    const result = id_comision ? await pool.query(query, [id_comision]) : await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error al obtener proyectos:', err);
    res.status(500).json({ error: 'Error al obtener proyectos' });
  }
});

app.post('/api/proyectos', async (req, res) => {
  const {
    tipo_documento,
    codigo_radicado,
    titulo,
    descripcion,
    id_comision,
    id_bancada,
    id_autor,
    estado,
    archivo_nombre,
    archivo_base64,
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO proyectos (
        tipo_documento, codigo_radicado, titulo, descripcion,
        id_comision, id_bancada, id_autor, estado, archivo_nombre, archivo_base64
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'Radicado'), $9, $10)
      RETURNING *`,
      [
        tipo_documento || 'Proyecto de Acuerdo',
        codigo_radicado,
        titulo,
        descripcion || '',
        id_comision || null,
        id_bancada || null,
        id_autor || null,
        estado,
        archivo_nombre || null,
        archivo_base64 || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error al radicar proyecto:', err);
    res.status(500).json({ error: 'Error al radicar proyecto' });
  }
});

app.patch('/api/proyectos/:id_proyecto/estado', async (req, res) => {
  const { id_proyecto } = req.params;
  const { estado } = req.body;
  try {
    const result = await pool.query(
      'UPDATE proyectos SET estado = $1 WHERE id_proyecto = $2 RETURNING *',
      [estado, id_proyecto]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error al actualizar estado del proyecto:', err);
    res.status(500).json({ error: 'Error al actualizar estado del proyecto' });
  }
});

// Ruta principal para servir el frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor Concejo Municipal Creer y Merecer activo en puerto ${PORT}`);
});