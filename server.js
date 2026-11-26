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

pool.connect(async (err, client, release) => {
    if (err) {
        console.error('❌ ERROR DE CONEXIÓN A POSTGRESQL:', err.message);
    } else {
        console.log('✅ Conexión exitosa a PostgreSQL (Concejo_Estudiantil)');
        try {
            // Crear tablas del módulo de votaciones si no existen
            await client.query(`
                CREATE TABLE IF NOT EXISTS votaciones (
                    id_votacion SERIAL PRIMARY KEY,
                    id_sesion INTEGER REFERENCES sesiones(id_sesion) ON DELETE CASCADE,
                    titulo VARCHAR(255) NOT NULL,
                    descripcion TEXT,
                    ambito VARCHAR(50) DEFAULT 'Plenaria',
                    estado VARCHAR(30) DEFAULT 'Abierta',
                    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS votos (
                    id_voto SERIAL PRIMARY KEY,
                    id_votacion INTEGER REFERENCES votaciones(id_votacion) ON DELETE CASCADE,
                    id_integrante INTEGER REFERENCES integrantes(id_integrante) ON DELETE CASCADE,
                    opcion VARCHAR(20) NOT NULL,
                    fecha_voto TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (id_votacion, id_integrante)
                );
            `);
        } catch (tableErr) {
            console.error('Error verificando tablas de votación:', tableErr.message);
        }
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
        const nuevaSesion = result.rows[0];

        if (comisionVal) {
            await pool.query(
                `INSERT INTO asistencias (id_sesion, id_integrante, estado)
                 SELECT $1, id_integrante, 'Ausente'
                 FROM integrantes
                 WHERE activo = TRUE AND id_comision = $2
                 ON CONFLICT DO NOTHING`,
                [nuevaSesion.id_sesion, comisionVal]
            );
        } else {
            await pool.query(
                `INSERT INTO asistencias (id_sesion, id_integrante, estado)
                 SELECT $1, id_integrante, 'Ausente'
                 FROM integrantes
                 WHERE activo = TRUE
                 ON CONFLICT DO NOTHING`,
                [nuevaSesion.id_sesion]
            );
        }

        res.json(nuevaSesion);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sesiones/:id_sesion', async (req, res) => {
    const idSesion = parseInt(req.params.id_sesion, 10);
    if (isNaN(idSesion)) return res.status(400).json({ error: 'ID de sesión inválido.' });
    try {
        await pool.query('DELETE FROM asistencias WHERE id_sesion = $1', [idSesion]);
        await pool.query('DELETE FROM intervenciones WHERE id_sesion = $1', [idSesion]);
        await pool.query('DELETE FROM sesiones WHERE id_sesion = $1', [idSesion]);
        res.json({ ok: true });
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

app.delete('/api/intervenciones/:id_intervencion', async (req, res) => {
    try {
        await pool.query('DELETE FROM intervenciones WHERE id_intervencion = $1', [req.params.id_intervencion]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 5. SISTEMA DE VOTACIÓN NOMINAL Y AUTENTICACIÓN DE CONCEJALES
// =========================================================================
function limpiarTextoComparacion(txt) {
    return (txt || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

// Login de concejal: primer nombre + primer apellido + contraseña cualquiera (modo prueba)
app.post('/api/votacion/login', async (req, res) => {
    const { primer_nombre, primer_apellido, password } = req.body;
    if (!primer_nombre || !primer_apellido || !password || !password.trim()) {
        return res.status(400).json({ error: 'Ingrese su primer nombre, primer apellido y contraseña.' });
    }

    const nomBuscado = limpiarTextoComparacion(primer_nombre).split(' ')[0];
    const apeBuscado = limpiarTextoComparacion(primer_apellido).split(' ')[0];

    try {
        const result = await pool.query(`
            SELECT i.id_integrante, i.nombre_completo, i.id_comision, i.id_bancada, i.es_directiva,
                   COALESCE(c.nombre, 'Sin Comisión') AS comision,
                   b.nombre AS bancada
            FROM integrantes i
            LEFT JOIN comisiones c ON i.id_comision = c.id_comision
            JOIN bancadas b ON i.id_bancada = b.id_bancada
            WHERE i.activo = TRUE
        `);

        const encontrado = result.rows.find((row) => {
            const palabras = limpiarTextoComparacion(row.nombre_completo).split(' ');
            const primerNombreReal = palabras[0] || '';
            const contieneApellido = palabras.slice(1).includes(apeBuscado);
            return primerNombreReal === nomBuscado && contieneApellido;
        });

        if (!encontrado) {
            return res.status(401).json({
                error: 'No se encontró ningún Honorable Concejal activo con ese primer nombre y primer apellido.',
            });
        }

        res.json({ ok: true, concejal: encontrado });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Obtener votaciones (de la sesión actual o todas las recientes)
app.get('/api/votaciones', async (req, res) => {
    const { id_sesion } = req.query;
    try {
        const result = id_sesion
            ? await pool.query('SELECT * FROM votaciones WHERE id_sesion = $1 ORDER BY id_votacion DESC', [id_sesion])
            : await pool.query('SELECT * FROM votaciones ORDER BY id_votacion DESC LIMIT 20');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear nueva votación / moción
app.post('/api/votaciones', async (req, res) => {
    const { id_sesion, titulo, descripcion, ambito } = req.body;
    if (!titulo || !titulo.trim()) {
        return res.status(400).json({ error: 'El título o pregunta de la votación es obligatorio.' });
    }
    try {
        const sesionVal = id_sesion ? parseInt(id_sesion, 10) : null;
        const result = await pool.query(
            `INSERT INTO votaciones (id_sesion, titulo, descripcion, ambito, estado)
             VALUES ($1, $2, $3, $4, 'Abierta') RETURNING *`,
            [sesionVal, titulo.trim(), descripcion || '', ambito || 'Plenaria']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Abrir o cerrar urna de votación
app.put('/api/votaciones/:id_votacion/estado', async (req, res) => {
    const { estado } = req.body;
    try {
        const result = await pool.query(
            'UPDATE votaciones SET estado = $1 WHERE id_votacion = $2 RETURNING *',
            [estado, req.params.id_votacion]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Eliminar votación
app.delete('/api/votaciones/:id_votacion', async (req, res) => {
    try {
        await pool.query('DELETE FROM votaciones WHERE id_votacion = $1', [req.params.id_votacion]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Consultar votos nominales de una votación
app.get('/api/votaciones/:id_votacion/votos', async (req, res) => {
    const idVotacion = parseInt(req.params.id_votacion, 10);
    if (isNaN(idVotacion)) return res.json([]);
    try {
        const result = await pool.query(`
            SELECT v.id_voto, v.id_votacion, v.id_integrante, v.opcion, v.fecha_voto,
                   i.nombre_completo, i.es_directiva, b.nombre AS bancada,
                   COALESCE(c.nombre, 'Sin Comisión') AS comision
            FROM votos v
            JOIN integrantes i ON v.id_integrante = i.id_integrante
            JOIN bancadas b ON i.id_bancada = b.id_bancada
            LEFT JOIN comisiones c ON i.id_comision = c.id_comision
            WHERE v.id_votacion = $1
            ORDER BY v.fecha_voto DESC
        `, [idVotacion]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Emitir o actualizar voto de un concejal autenticado
app.post('/api/votaciones/:id_votacion/votar', async (req, res) => {
    const idVotacion = parseInt(req.params.id_votacion, 10);
    const { id_integrante, opcion } = req.body;

    if (!['SI', 'NO', 'ABSTENCION'].includes(opcion)) {
        return res.status(400).json({ error: 'Opción de voto inválida.' });
    }

    try {
        const votRes = await pool.query('SELECT estado FROM votaciones WHERE id_votacion = $1', [idVotacion]);
        if (votRes.rows.length === 0) {
            return res.status(404).json({ error: 'La votación no existe.' });
        }
        if (votRes.rows[0].estado !== 'Abierta') {
            return res.status(403).json({ error: 'La urna de votación ya se encuentra cerrada.' });
        }

        const result = await pool.query(
            `INSERT INTO votos (id_votacion, id_integrante, opcion, fecha_voto)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (id_votacion, id_integrante)
             DO UPDATE SET opcion = EXCLUDED.opcion, fecha_voto = CURRENT_TIMESTAMP
             RETURNING *`,
            [idVotacion, parseInt(id_integrante, 10), opcion]
        );
        res.json({ ok: true, voto: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Aplicación Creer y Merecer lista en: http://localhost:${PORT}`);
});