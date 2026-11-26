const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

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

// =========================================================================
// SEGURIDAD ADMINISTRATIVA (CLAVE MAESTRA: Concejo2026) )
// =========================================================================
const CLAVE_ADMIN_MAESTRA = 'Concejo2026)';
const sesionesAdminActivas = new Map();

function verificarAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !sesionesAdminActivas.has(token)) {
        return res.status(401).json({
            error: 'Acceso denegado. Debe registrarse como Administrador con la clave institucional para realizar esta acción.',
        });
    }
    req.adminUsuario = sesionesAdminActivas.get(token);
    next();
}

app.post('/api/admin/registro', async (req, res) => {
    const { nombre_admin, cargo_admin, password } = req.body;
    if (!nombre_admin || !nombre_admin.trim()) {
        return res.status(400).json({ error: 'Ingrese su nombre completo para registrarse como administrador.' });
    }
    if (!password || password.trim() !== CLAVE_ADMIN_MAESTRA) {
        return res.status(401).json({ error: 'Clave administrativa incorrecta.' });
    }

    try {
        await asegurarTablasSistema();
        const cargoLimpio = (cargo_admin && cargo_admin.trim()) ? cargo_admin.trim() : 'Mesa Directiva / Secretaría';
        const reg = await pool.query(
            `INSERT INTO administradores_registro (nombre_admin, cargo_admin)
             VALUES ($1, $2) RETURNING *`,
            [nombre_admin.trim(), cargoLimpio]
        );

        const token = crypto.randomBytes(24).toString('hex');
        const infoAdmin = {
            id_admin: reg.rows[0].id_admin,
            nombre_admin: reg.rows[0].nombre_admin,
            cargo_admin: reg.rows[0].cargo_admin,
            fecha_ingreso: reg.rows[0].fecha_ingreso,
        };
        sesionesAdminActivas.set(token, infoAdmin);

        res.json({ ok: true, token, admin: infoAdmin });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/verificar', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token && sesionesAdminActivas.has(token)) {
        return res.json({ ok: true, admin: sesionesAdminActivas.get(token) });
    }
    res.status(401).json({ ok: false });
});

app.post('/api/admin/salir', (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token) sesionesAdminActivas.delete(token);
    res.json({ ok: true });
});

// =========================================================================
// CANAL EN TIEMPO REAL (SERVER-SENT EVENTS) PARA TODOS LOS CONECTADOS
// =========================================================================
const clientesSSE = new Set();

app.get('/api/eventos', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ tipo: 'conectado', ts: Date.now() })}\n\n`);
    clientesSSE.add(res);

    const ping = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch (e) {
            clearInterval(ping);
            clientesSSE.delete(res);
        }
    }, 20000);

    req.on('close', () => {
        clearInterval(ping);
        clientesSSE.delete(res);
    });
});

function emitirActualizacionGlobal(tipo, extra = {}) {
    const payload = `data: ${JSON.stringify({ tipo, ts: Date.now(), ...extra })}\n\n`;
    for (const cliente of clientesSSE) {
        try {
            cliente.write(payload);
        } catch (e) {
            clientesSSE.delete(cliente);
        }
    }
}

let tablasSistemaListas = false;

async function asegurarTablasSistema() {
    if (tablasSistemaListas) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS administradores_registro (
            id_admin SERIAL PRIMARY KEY,
            nombre_admin VARCHAR(180) NOT NULL,
            cargo_admin VARCHAR(120) DEFAULT 'Secretaría General',
            fecha_ingreso TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS votaciones (
            id_votacion SERIAL PRIMARY KEY,
            id_sesion INTEGER,
            id_proyecto INTEGER,
            titulo VARCHAR(255) NOT NULL,
            descripcion TEXT,
            ambito VARCHAR(50) DEFAULT 'Plenaria',
            estado VARCHAR(30) DEFAULT 'Abierta',
            duracion_seg INTEGER DEFAULT 120,
            fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            fecha_cierre TIMESTAMP
        );
    `);
    await pool.query(`ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS id_proyecto INTEGER;`);
    await pool.query(`ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS duracion_seg INTEGER DEFAULT 120;`);
    await pool.query(`ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS fecha_cierre TIMESTAMP;`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS votos (
            id_voto SERIAL PRIMARY KEY,
            id_votacion INTEGER NOT NULL,
            id_integrante INTEGER NOT NULL,
            opcion VARCHAR(20) NOT NULL,
            fecha_voto TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (id_votacion, id_integrante)
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS votacion_registros (
            id_registro SERIAL PRIMARY KEY,
            id_votacion INTEGER NOT NULL,
            id_integrante INTEGER NOT NULL,
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (id_votacion, id_integrante)
        );
    `);
    tablasSistemaListas = true;
}

asegurarTablasSistema()
    .then(() => console.log('✅ Conexión exitosa a PostgreSQL y tablas verificadas'))
    .catch((err) => console.error('❌ ERROR INICIALIZANDO POSTGRESQL:', err.message));

// =========================================================================
// 1. GESTIÓN DE CONCEJALES (LECTURA PÚBLICA / EDICIÓN SOLO ADMIN)
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

app.post('/api/integrantes', verificarAdmin, async (req, res) => {
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

        emitirActualizacionGlobal('integrantes');
        res.json(nuevo);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/integrantes/:id_integrante', verificarAdmin, async (req, res) => {
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
        emitirActualizacionGlobal('integrantes');
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/integrantes/:id_integrante', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM integrantes WHERE id_integrante = $1', [req.params.id_integrante]);
        emitirActualizacionGlobal('integrantes');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 2. SESIONES LIBRES Y ASISTENCIA (LECTURA PÚBLICA / EDICIÓN SOLO ADMIN)
// =========================================================================
app.get('/api/sesiones', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sesiones ORDER BY id_sesion DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sesiones', verificarAdmin, async (req, res) => {
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

        emitirActualizacionGlobal('sesiones');
        res.json(nuevaSesion);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sesiones/:id_sesion', verificarAdmin, async (req, res) => {
    const idSesion = parseInt(req.params.id_sesion, 10);
    if (isNaN(idSesion)) return res.status(400).json({ error: 'ID de sesión inválido.' });
    try {
        await pool.query('DELETE FROM asistencias WHERE id_sesion = $1', [idSesion]);
        await pool.query('DELETE FROM intervenciones WHERE id_sesion = $1', [idSesion]);
        await pool.query('DELETE FROM sesiones WHERE id_sesion = $1', [idSesion]);
        emitirActualizacionGlobal('sesiones');
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

app.put('/api/asistencias/:id_asistencia', verificarAdmin, async (req, res) => {
    const { estado } = req.body;
    try {
        const result = await pool.query(
            `UPDATE asistencias 
             SET estado = $1, hora_registro = CURRENT_TIME 
             WHERE id_asistencia = $2 RETURNING *`,
            [estado, req.params.id_asistencia]
        );
        emitirActualizacionGlobal('asistencias');
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/asistencias/sesion/:id_sesion/todos-presentes', verificarAdmin, async (req, res) => {
    try {
        await pool.query(
            `UPDATE asistencias SET estado = 'Presente', hora_registro = CURRENT_TIME WHERE id_sesion = $1`,
            [req.params.id_sesion]
        );
        emitirActualizacionGlobal('asistencias');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 3. PROYECTOS DE ACUERDO Y PROPOSICIONES (LECTURA PÚBLICA / EDICIÓN SOLO ADMIN)
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

app.post('/api/proyectos', verificarAdmin, async (req, res) => {
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
        emitirActualizacionGlobal('proyectos');
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/proyectos/:id_proyecto/estado', verificarAdmin, async (req, res) => {
    const { estado } = req.body;
    try {
        const result = await pool.query(
            `UPDATE proyectos SET estado = $1 WHERE id_proyecto = $2 RETURNING *`,
            [estado, req.params.id_proyecto]
        );
        emitirActualizacionGlobal('proyectos');
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/proyectos/:id_proyecto', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM proyectos WHERE id_proyecto = $1', [req.params.id_proyecto]);
        emitirActualizacionGlobal('proyectos');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 4. INTERVENCIONES (LECTURA PÚBLICA / EDICIÓN SOLO ADMIN)
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

app.post('/api/intervenciones', verificarAdmin, async (req, res) => {
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
        emitirActualizacionGlobal('intervenciones');
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/intervenciones/:id_intervencion', verificarAdmin, async (req, res) => {
    const { tiempo_usado_seg, estado } = req.body;
    try {
        const result = await pool.query(
            `UPDATE intervenciones SET tiempo_usado_seg = $1, estado = $2 WHERE id_intervencion = $3 RETURNING *`,
            [tiempo_usado_seg, estado, req.params.id_intervencion]
        );
        emitirActualizacionGlobal('intervenciones');
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/intervenciones/:id_intervencion', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM intervenciones WHERE id_intervencion = $1', [req.params.id_intervencion]);
        emitirActualizacionGlobal('intervenciones');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 5. SISTEMA DE VOTACIÓN NOMINAL (VOTO CONCEJAL LIBRE / ABRIR-CERRAR URNA ADMIN)
// =========================================================================
function limpiarTextoComparacion(txt) {
    return (txt || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

async function cerrarVotacionesExpiradas() {
    await asegurarTablasSistema();
    const res = await pool.query(`
        UPDATE votaciones
        SET estado = 'Cerrada'
        WHERE estado = 'Abierta'
          AND fecha_cierre IS NOT NULL
          AND fecha_cierre <= NOW()
        RETURNING id_votacion
    `);
    if (res.rowCount > 0) {
        emitirActualizacionGlobal('votaciones');
    }
}

app.post('/api/votacion/login', async (req, res) => {
    const { primer_nombre, primer_apellido, password, id_votacion } = req.body;
    if (!primer_nombre || !primer_apellido || !password || !password.trim()) {
        return res.status(400).json({ error: 'Ingrese su primer nombre, primer apellido y contraseña.' });
    }

    const nomBuscado = limpiarTextoComparacion(primer_nombre).split(' ')[0];
    const apeBuscado = limpiarTextoComparacion(primer_apellido).split(' ')[0];

    try {
        await cerrarVotacionesExpiradas();

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

        if (id_votacion) {
            const idVot = parseInt(id_votacion, 10);
            const votInfo = await pool.query('SELECT estado FROM votaciones WHERE id_votacion = $1', [idVot]);
            if (votInfo.rows.length > 0 && votInfo.rows[0].estado !== 'Abierta') {
                return res.status(403).json({
                    error: 'El tiempo de votación ya concluyó y la urna se encuentra cerrada.',
                });
            }

            const votoPrevio = await pool.query(
                'SELECT id_voto FROM votos WHERE id_votacion = $1 AND id_integrante = $2',
                [idVot, encontrado.id_integrante]
            );
            const regPrevio = await pool.query(
                'SELECT id_registro FROM votacion_registros WHERE id_votacion = $1 AND id_integrante = $2',
                [idVot, encontrado.id_integrante]
            );

            if (votoPrevio.rows.length > 0 || regPrevio.rows.length > 0) {
                return res.status(409).json({
                    error: `El H.C. ${encontrado.nombre_completo} ya se registró previamente en esta votación y no puede volver a ingresar.`,
                });
            }

            await pool.query(
                `INSERT INTO votacion_registros (id_votacion, id_integrante)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [idVot, encontrado.id_integrante]
            );
        }

        res.json({ ok: true, concejal: encontrado });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/votaciones', async (req, res) => {
    const { id_sesion } = req.query;
    try {
        await cerrarVotacionesExpiradas();
        const queryBase = `
            SELECT v.*,
                   GREATEST(0, EXTRACT(EPOCH FROM (v.fecha_cierre - NOW())))::INTEGER AS segundos_restantes,
                   p.codigo_radicado AS proyecto_codigo,
                   p.titulo AS proyecto_titulo,
                   p.tipo_documento AS proyecto_tipo
            FROM votaciones v
            LEFT JOIN proyectos p ON v.id_proyecto = p.id_proyecto
        `;
        const result = id_sesion
            ? await pool.query(`${queryBase} WHERE v.id_sesion = $1 ORDER BY v.id_votacion DESC`, [id_sesion])
            : await pool.query(`${queryBase} ORDER BY v.id_votacion DESC LIMIT 20`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/votaciones', verificarAdmin, async (req, res) => {
    const { id_sesion, id_proyecto, titulo, descripcion, ambito, duracion_seg } = req.body;
    if (!titulo || !titulo.trim()) {
        return res.status(400).json({ error: 'Seleccione un proyecto o ingrese el asunto a votar.' });
    }
    try {
        await asegurarTablasSistema();
        const sesionVal = id_sesion ? parseInt(id_sesion, 10) : null;
        const proyectoVal = id_proyecto ? parseInt(id_proyecto, 10) : null;
        const duracionVal = Math.max(15, parseInt(duracion_seg, 10) || 120);

        const result = await pool.query(
            `INSERT INTO votaciones (id_sesion, id_proyecto, titulo, descripcion, ambito, estado, duracion_seg, fecha_cierre)
             VALUES ($1, $2, $3, $4, $5, 'Abierta', $6::INTEGER, NOW() + make_interval(secs => $6::INTEGER))
             RETURNING *, GREATEST(0, EXTRACT(EPOCH FROM (fecha_cierre - NOW())))::INTEGER AS segundos_restantes`,
            [sesionVal, proyectoVal, titulo.trim(), descripcion || '', ambito || 'Plenaria', duracionVal]
        );
        emitirActualizacionGlobal('votaciones', { id_votacion: result.rows[0].id_votacion });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/votaciones/:id_votacion/estado', verificarAdmin, async (req, res) => {
    const { estado } = req.body;
    const idVot = parseInt(req.params.id_votacion, 10);
    try {
        await asegurarTablasSistema();
        let result;
        if (estado === 'Abierta') {
            result = await pool.query(
                `UPDATE votaciones 
                 SET estado = 'Abierta',
                     fecha_cierre = NOW() + make_interval(secs => COALESCE(duracion_seg, 120)::INTEGER)
                 WHERE id_votacion = $1 RETURNING *`,
                [idVot]
            );
        } else {
            result = await pool.query(
                `UPDATE votaciones SET estado = 'Cerrada', fecha_cierre = NOW() WHERE id_votacion = $1 RETURNING *`,
                [idVot]
            );
        }
        emitirActualizacionGlobal('votaciones', { id_votacion: idVot });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/votaciones/:id_votacion', verificarAdmin, async (req, res) => {
    const idVot = parseInt(req.params.id_votacion, 10);
    try {
        await asegurarTablasSistema();
        await pool.query('DELETE FROM votos WHERE id_votacion = $1', [idVot]);
        await pool.query('DELETE FROM votacion_registros WHERE id_votacion = $1', [idVot]);
        await pool.query('DELETE FROM votaciones WHERE id_votacion = $1', [idVot]);
        emitirActualizacionGlobal('votaciones');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/votaciones/:id_votacion/votos', async (req, res) => {
    const idVotacion = parseInt(req.params.id_votacion, 10);
    if (isNaN(idVotacion)) return res.json({ votacion: null, votos: [] });
    try {
        await cerrarVotacionesExpiradas();
        const votRes = await pool.query(`
            SELECT v.*,
                   GREATEST(0, EXTRACT(EPOCH FROM (v.fecha_cierre - NOW())))::INTEGER AS segundos_restantes,
                   p.codigo_radicado AS proyecto_codigo,
                   p.titulo AS proyecto_titulo,
                   p.tipo_documento AS proyecto_tipo
            FROM votaciones v
            LEFT JOIN proyectos p ON v.id_proyecto = p.id_proyecto
            WHERE v.id_votacion = $1
        `, [idVotacion]);

        const votosRes = await pool.query(`
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

        res.json({
            votacion: votRes.rows[0] || null,
            votos: votosRes.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/votaciones/:id_votacion/votar', async (req, res) => {
    const idVotacion = parseInt(req.params.id_votacion, 10);
    const { id_integrante, opcion } = req.body;
    const idInt = parseInt(id_integrante, 10);

    if (!['SI', 'NO', 'ABSTENCION'].includes(opcion)) {
        return res.status(400).json({ error: 'Opción de voto inválida.' });
    }

    try {
        await cerrarVotacionesExpiradas();
        const votRes = await pool.query('SELECT estado FROM votaciones WHERE id_votacion = $1', [idVotacion]);
        if (votRes.rows.length === 0) {
            return res.status(404).json({ error: 'La votación no existe.' });
        }
        if (votRes.rows[0].estado !== 'Abierta') {
            return res.status(403).json({ error: 'El tiempo expiró y la urna de votación se encuentra cerrada.' });
        }

        const yaVoto = await pool.query(
            'SELECT id_voto FROM votos WHERE id_votacion = $1 AND id_integrante = $2',
            [idVotacion, idInt]
        );
        if (yaVoto.rows.length > 0) {
            return res.status(409).json({
                error: 'Este Honorable Concejal ya registró su voto en esta urna y no puede volver a votar.',
            });
        }

        await pool.query(
            `INSERT INTO votacion_registros (id_votacion, id_integrante)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [idVotacion, idInt]
        );

        const result = await pool.query(
            `INSERT INTO votos (id_votacion, id_integrante, opcion, fecha_voto)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             RETURNING *`,
            [idVotacion, idInt, opcion]
        );
        emitirActualizacionGlobal('votos', { id_votacion: idVotacion });
        res.json({ ok: true, voto: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Aplicación Creer y Merecer lista en: http://localhost:${PORT}`);
});