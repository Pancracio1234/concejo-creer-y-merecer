const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================================
// CONFIGURACIÓN DE CONEXIÓN A POSTGRESQL (NEON EN NUBE / LOCAL RESPALDO)
// =========================================================================
const pool = new Pool(
    process.env.DATABASE_URL
        ? {
              connectionString: process.env.DATABASE_URL,
              ssl: { rejectUnauthorized: false },
          }
        : {
              user: 'postgres',
              host: 'localhost',
              database: 'Concejo_Estudiantil',
              password: 'Albaricoque98)',
              port: 5432,
          }
);

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ ERROR DE CONEXIÓN A POSTGRESQL:', err.message);
    } else {
        console.log('✅ Conexión exitosa a PostgreSQL (Concejo_Estudiantil)');
        release();
    }
});

// =========================================================================
// 1. GESTIÓN DE CONCEJALES (AÑADIR, RECOLOCAR BANCADA/COMISIÓN, ELIMINAR)
// =========================================================================
app.get('/api/integrantes', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT i.id_integrante, i.nombre_completo, i.id_comision, i.id_bancada, i.es_directiva, i.activo,
                   COALESCE(c.nombre, 'Sin Comisión') AS comision,
                   b.nombre AS bancada
            FROM integrantes i
            LEFT JOIN comisiones c ON i.id_comision = c.id_comision
            JOIN bancadas b ON i.id_bancada = b.id_bancada
            WHERE i.activo = TRUE
            ORDER BY b.id_bancada ASC, c.id_comision ASC NULLS LAST, i.es_directiva DESC, i.nombre_completo ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/integrantes', async (req, res) => {
    const { nombre_completo, id_comision, id_bancada, es_directiva, id_sesion } = req.body;
    if (!nombre_completo || !nombre_completo.trim()) {
        return res.status(400).json({ error: 'El nombre completo es obligatorio.' });
    }
    try {
        const comisionVal = id_comision ? parseInt(id_comision, 10) : null;
        const bancadaVal = id_bancada ? parseInt(id_bancada, 10) : 3;
        const directivaVal = Boolean(es_directiva);

        const result = await pool.query(
            `INSERT INTO integrantes (nombre_completo, id_comision, id_bancada, es_directiva, activo)
             VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
            [nombre_completo.trim(), comisionVal, bancadaVal, directivaVal]
        );
        const nuevo = result.rows[0];

        if (id_sesion) {
            await pool.query(
                `INSERT INTO asistencias (id_sesion, id_integrante, estado)
                 VALUES ($1, $2, 'Ausente') ON CONFLICT DO NOTHING`,
                [parseInt(id_sesion, 10), nuevo.id_integrante]
            );
        }

        res.json(nuevo);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/integrantes/:id_integrante', async (req, res) => {
    const { nombre_completo, id_comision, id_bancada, es_directiva } = req.body;
    const idInt = parseInt(req.params.id_integrante, 10);
    try {
        const comisionVal = (id_comision === '' || id_comision === null || id_comision === undefined) 
            ? null 
            : parseInt(id_comision, 10);
        const bancadaVal = parseInt(id_bancada, 10);
        const directivaVal = Boolean(es_directiva);

        const result = await pool.query(
            `UPDATE integrantes 
             SET nombre_completo = COALESCE($1, nombre_completo),
                 id_comision = $2,
                 id_bancada = $3,
                 es_directiva = $4
             WHERE id_integrante = $5 RETURNING *`,
            [nombre_completo ? nombre_completo.trim() : null, comisionVal, bancadaVal, directivaVal, idInt]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/integrantes/:id_integrante', async (req, res) => {
    try {
        await pool.query('DELETE FROM integrantes WHERE id_integrante = $1', [req.params.id_integrante]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 2. SESIONES LIBRES Y ASISTENCIA
// =========================================================================
app.get('/api/sesiones', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sesiones ORDER BY id_sesion DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sesiones', async (req, res) => {
    const { titulo, tipo_sesion, id_comision } = req.body;
    if (!titulo || !titulo.trim()) {
        return res.status(400).json({ error: 'El nombre de la sesión es obligatorio.' });
    }
    try {
        const modalidad = (tipo_sesion && tipo_sesion.trim()) ? tipo_sesion.trim() : 'General';
        const comisionVal = id_comision ? parseInt(id_comision, 10) : null;

        const result = await pool.query(
            `INSERT INTO sesiones (titulo, tipo_sesion, id_comision, estado) 
             VALUES ($1, $2, $3, 'En Curso') RETURNING *`,
            [titulo.trim(), modalidad, comisionVal]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/asistencias/:id_sesion', async (req, res) => {
    const idSesion = parseInt(req.params.id_sesion, 10);
    if (isNaN(idSesion)) return res.json([]);
    try {
        const result = await pool.query(`
            SELECT a.*, i.nombre_completo, i.es_directiva, b.id_bancada, b.nombre AS bancada, 
                   COALESCE(c.nombre, 'Sin Comisión') AS comision
            FROM asistencias a
            JOIN integrantes i ON a.id_integrante = i.id_integrante
            JOIN bancadas b ON i.id_bancada = b.id_bancada
            LEFT JOIN comisiones c ON i.id_comision = c.id_comision
            WHERE a.id_sesion = $1
            ORDER BY b.id_bancada ASC, i.es_directiva DESC, i.nombre_completo ASC
        `, [idSesion]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/asistencias/:id_asistencia', async (req, res) => {
    const { estado } = req.body;
    try {
        const result = await pool.query(
            `UPDATE asistencias 
             SET estado = $1, hora_registro = CURRENT_TIME 
             WHERE id_asistencia = $2 RETURNING *`,
            [estado, req.params.id_asistencia]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/asistencias/sesion/:id_sesion/todos-presentes', async (req, res) => {
    try {
        await pool.query(
            `UPDATE asistencias SET estado = 'Presente', hora_registro = CURRENT_TIME WHERE id_sesion = $1`,
            [req.params.id_sesion]
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 3. PROYECTOS DE ACUERDO Y PROPOSICIONES
// =========================================================================
app.get('/api/proyectos', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.*, COALESCE(i.nombre_completo, 'Mesa Directiva / Bancada') AS autor, 
                   COALESCE(c.nombre, 'Plenaria') AS comision
            FROM proyectos p
            LEFT JOIN integrantes i ON p.id_autor = i.id_integrante
            LEFT JOIN comisiones c ON p.id_comision_asignada = c.id_comision
            ORDER BY p.id_proyecto DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proyectos', async (req, res) => {
    const { 
        codigo_radicado, 
        titulo, 
        descripcion, 
        id_autor, 
        id_comision_asignada, 
        tipo_documento,
        archivo_nombre,
        archivo_contenido 
    } = req.body;

    if (!codigo_radicado || !titulo) {
        return res.status(400).json({ error: 'Código y título son obligatorios.' });
    }
    try {
        const comisionId = id_comision_asignada ? parseInt(id_comision_asignada, 10) : null;
        const autorId = id_autor ? parseInt(id_autor, 10) : null;
        const result = await pool.query(
            `INSERT INTO proyectos (
                codigo_radicado, titulo, descripcion, id_autor, id_comision_asignada, 
                tipo_documento, archivo_nombre, archivo_contenido
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                codigo_radicado.trim(), 
                titulo.trim(), 
                descripcion || '', 
                autorId, 
                comisionId,
                tipo_documento || 'Proyecto de Acuerdo',
                archivo_nombre || null,
                archivo_contenido || null
            ]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/proyectos/:id_proyecto/estado', async (req, res) => {
    const { estado } = req.body;
    try {
        const result = await pool.query(
            `UPDATE proyectos SET estado = $1 WHERE id_proyecto = $2 RETURNING *`,
            [estado, req.params.id_proyecto]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/proyectos/:id_proyecto', async (req, res) => {
    try {
        await pool.query('DELETE FROM proyectos WHERE id_proyecto = $1', [req.params.id_proyecto]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 4. INTERVENCIONES (USO DE LA PALABRA: LISTAR, AÑADIR, ACTUALIZAR, RETIRAR)
// =========================================================================
app.get('/api/intervenciones/:id_sesion', async (req, res) => {
    const idSesion = parseInt(req.params.id_sesion, 10);
    if (isNaN(idSesion)) return res.json([]);
    try {
        const result = await pool.query(`
            SELECT iv.*, i.nombre_completo, b.nombre AS bancada, COALESCE(c.nombre, 'Sin Comisión') AS comision
            FROM intervenciones iv
            JOIN integrantes i ON iv.id_integrante = i.id_integrante
            JOIN bancadas b ON i.id_bancada = b.id_bancada
            LEFT JOIN comisiones c ON i.id_comision = c.id_comision
            WHERE iv.id_sesion = $1
            ORDER BY iv.orden_turno ASC
        `, [idSesion]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/intervenciones', async (req, res) => {
    const { id_sesion, id_integrante, tipo_intervencion, tiempo_asignado_seg } = req.body;
    try {
        const ordenRes = await pool.query(
            'SELECT COALESCE(MAX(orden_turno), 0) + 1 AS siguiente FROM intervenciones WHERE id_sesion = $1',
            [id_sesion]
        );
        const result = await pool.query(
            `INSERT INTO intervenciones (id_sesion, id_integrante, tipo_intervencion, tiempo_asignado_seg, orden_turno)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [id_sesion, id_integrante, tipo_intervencion, parseInt(tiempo_asignado_seg, 10), ordenRes.rows[0].siguiente]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/intervenciones/:id_intervencion', async (req, res) => {
    const { tiempo_usado_seg, estado } = req.body;
    try {
        const result = await pool.query(
            `UPDATE intervenciones SET tiempo_usado_seg = $1, estado = $2 WHERE id_intervencion = $3 RETURNING *`,
            [tiempo_usado_seg, estado, req.params.id_intervencion]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Retirar intervención de la cola de oradores
app.delete('/api/intervenciones/:id_intervencion', async (req, res) => {
    try {
        await pool.query('DELETE FROM intervenciones WHERE id_intervencion = $1', [req.params.id_intervencion]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Aplicación Creer y Merecer lista en: http://localhost:${PORT}`);
});