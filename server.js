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
// SEGURIDAD Y SESIÓN ÚNICA (ADMINISTRADOR Y CONCEJALES)
// =========================================================================
const CLAVE_ADMIN_MAESTRA = 'Concejo2026)';
const sesionesAdminActivas = new Map();
const sesionesConcejalActivas = new Map();

function esTokenAdminValido(token) {
    return Boolean(token && sesionesAdminActivas.has(token));
}

function esTokenConcejalValido(token) {
    return Boolean(token && sesionesConcejalActivas.has(token));
}

function verificarAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!esTokenAdminValido(token)) {
        return res.status(401).json({
            error: 'Acceso denegado. Debe iniciar sesión como Administrador con la clave institucional para realizar esta acción.',
        });
    }
    req.adminUsuario = sesionesAdminActivas.get(token);
    next();
}

function verificarConcejal(req, res, next) {
    const token = req.headers['x-concejal-token'];
    if (!esTokenConcejalValido(token)) {
        return res.status(401).json({
            error: 'Debe iniciar sesión como Honorable Concejal al ingresar a la aplicación.',
        });
    }
    req.concejalUsuario = sesionesConcejalActivas.get(token);
    next();
}

function limpiarTextoComparacion(txt) {
    return (txt || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

async function autenticarConcejalPorNombre(primer_nombre, primer_apellido, password) {
    if (!primer_nombre || !primer_apellido || !password || !password.trim()) {
        return { error: 'Ingrese su primer nombre, primer apellido y contraseña.', status: 400 };
    }

    const nomBuscado = limpiarTextoComparacion(primer_nombre).split(' ')[0];
    const apeBuscado = limpiarTextoComparacion(primer_apellido).split(' ')[0];

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
        return {
            error: 'No se encontró ningún Honorable Concejal activo con ese primer nombre y primer apellido.',
            status: 401,
        };
    }

    return { concejal: encontrado };
}

// =========================================================================
// INICIO DE SESIÓN ÚNICO AL ENTRAR A LA APLICACIÓN (ADMIN O CONCEJAL)
// =========================================================================
app.post('/api/sesion/login', async (req, res) => {
    const { rol, nombre_admin, cargo_admin, primer_nombre, primer_apellido, password } = req.body;

    try {
        await asegurarTablasSistema();

        // 1. INGRESO COMO ADMINISTRADOR
        if (rol === 'admin') {
            if (!nombre_admin || !nombre_admin.trim()) {
                return res.status(400).json({ error: 'Ingrese su nombre completo para ingresar como administrador.' });
            }
            if (!password || password.trim() !== CLAVE_ADMIN_MAESTRA) {
                return res.status(401).json({ error: 'Clave administrativa incorrecta.' });
            }

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

            return res.json({
                ok: true,
                rol: 'admin',
                token,
                usuario: infoAdmin,
                escenarios_habilitados: ['quorum', 'intervenciones', 'votaciones', 'proyectos', 'integrantes', 'configuracion'],
            });
        }

        // 2. INGRESO COMO CONCEJAL (UNA SOLA VEZ AL ENTRAR)
        if (rol === 'concejal') {
            const auth = await autenticarConcejalPorNombre(primer_nombre, primer_apellido, password);
            if (auth.error) {
                return res.status(auth.status).json({ error: auth.error });
            }

            const token = crypto.randomBytes(24).toString('hex');
            sesionesConcejalActivas.set(token, auth.concejal);

            return res.json({
                ok: true,
                rol: 'concejal',
                token,
                usuario: auth.concejal,
                // Solo los 3 escenarios permitidos para el concejal (sin quórum ni administración)
                escenarios_habilitados: ['intervenciones', 'votaciones', 'proyectos'],
            });
        }

        return res.status(400).json({ error: 'Seleccione un rol válido (admin o concejal).' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Verificar sesión activa al recargar la página
app.get('/api/sesion/verificar', (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (esTokenAdminValido(adminToken)) {
        return res.json({
            ok: true,
            rol: 'admin',
            usuario: sesionesAdminActivas.get(adminToken),
            escenarios_habilitados: ['quorum', 'intervenciones', 'votaciones', 'proyectos', 'integrantes', 'configuracion'],
        });
    }

    const concejalToken = req.headers['x-concejal-token'];
    if (esTokenConcejalValido(concejalToken)) {
        return res.json({
            ok: true,
            rol: 'concejal',
            usuario: sesionesConcejalActivas.get(concejalToken),
            escenarios_habilitados: ['intervenciones', 'votaciones', 'proyectos'],
        });
    }

    res.status(401).json({ ok: false });
});

app.post('/api/sesion/salir', (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    const concejalToken = req.headers['x-concejal-token'];
    if (adminToken) sesionesAdminActivas.delete(adminToken);
    if (concejalToken) sesionesConcejalActivas.delete(concejalToken);
    res.json({ ok: true });
});

// Endpoints heredados de compatibilidad para admin
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
    if (esTokenAdminValido(token)) {
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

// =========================================================================
// INICIALIZACIÓN Y MIGRACIÓN SEGURA DE TABLAS EN POSTGRESQL
// =========================================================================
let tablasSistemaListas = false;

async function asegurarTablasSistema() {
    if (tablasSistemaListas) return;

    await pool.query(`
        CREATE TABLE IF NOT EXISTS configuracion_visual (
            id_config INTEGER PRIMARY KEY DEFAULT 1,
            logo_base64 TEXT,
            marca_agua_visible BOOLEAN DEFAULT TRUE,
            marca_agua_estilo VARCHAR(30) DEFAULT 'oro',
            marca_agua_opacidad INTEGER DEFAULT 11,
            marca_agua_tamano INTEGER DEFAULT 560,
            actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await pool.query(`
        INSERT INTO configuracion_visual (id_config)
        VALUES (1)
        ON CONFLICT (id_config) DO NOTHING;
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS administradores_registro (
            id_admin SERIAL PRIMARY KEY,
            nombre_admin VARCHAR(180) NOT NULL,
            cargo_admin VARCHAR(120) DEFAULT 'Secretaría General',
            fecha_ingreso TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Columnas de visibilidad (Público / Privado) en proyectos y proposiciones
    await pool.query(`
        ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS visible_publico BOOLEAN DEFAULT TRUE;
    `);
    await pool.query(`
        ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS fecha_radicacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    // Detalle del motivo de solicitud de uso de la palabra
    await pool.query(`
        ALTER TABLE intervenciones ADD COLUMN IF NOT EXISTS motivo_detalle TEXT;
    `);
    await pool.query(`
        ALTER TABLE intervenciones ADD COLUMN IF NOT EXISTS fecha_solicitud TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
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
            ronda_numero INTEGER DEFAULT 1,
            resultado_final VARCHAR(60),
            mensaje_veredicto TEXT,
            fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            fecha_cierre TIMESTAMP
        );
    `);
    await pool.query(`ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS id_proyecto INTEGER;`);
    await pool.query(`ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS duracion_seg INTEGER DEFAULT 120;`);
    await pool.query(`ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS fecha_cierre TIMESTAMP;`);
    await pool.query(`ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS ronda_numero INTEGER DEFAULT 1;`);
    await pool.query(`ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS resultado_final VARCHAR(60);`);
    await pool.query(`ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS mensaje_veredicto TEXT;`);

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
// CONFIGURACIÓN VISUAL GLOBAL
// =========================================================================
app.get('/api/configuracion-visual', async (req, res) => {
    try {
        await asegurarTablasSistema();
        const result = await pool.query(`SELECT * FROM configuracion_visual WHERE id_config = 1`);
        res.json(result.rows[0] || {
            logo_base64: null,
            marca_agua_visible: true,
            marca_agua_estilo: 'oro',
            marca_agua_opacidad: 11,
            marca_agua_tamano: 560,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/configuracion-visual', verificarAdmin, async (req, res) => {
    const {
        logo_base64,
        marca_agua_visible,
        marca_agua_estilo,
        marca_agua_opacidad,
        marca_agua_tamano,
    } = req.body;

    try {
        await asegurarTablasSistema();
        const actualRes = await pool.query(`SELECT * FROM configuracion_visual WHERE id_config = 1`);
        const actual = actualRes.rows[0] || {};

        const nuevoLogo = logo_base64 !== undefined ? logo_base64 : actual.logo_base64;
        const nuevaVisibilidad = marca_agua_visible !== undefined ? Boolean(marca_agua_visible) : actual.marca_agua_visible;
        const nuevoEstilo = marca_agua_estilo || actual.marca_agua_estilo || 'oro';
        const nuevaOpacidad = marca_agua_opacidad !== undefined ? parseInt(marca_agua_opacidad, 10) : (actual.marca_agua_opacidad || 11);
        const nuevoTamano = marca_agua_tamano !== undefined ? parseInt(marca_agua_tamano, 10) : (actual.marca_agua_tamano || 560);

        const updated = await pool.query(
            `UPDATE configuracion_visual
             SET logo_base64 = $1,
                 marca_agua_visible = $2,
                 marca_agua_estilo = $3,
                 marca_agua_opacidad = $4,
                 marca_agua_tamano = $5,
                 actualizado_en = NOW()
             WHERE id_config = 1
             RETURNING *`,
            [nuevoLogo, nuevaVisibilidad, nuevoEstilo, nuevaOpacidad, nuevoTamano]
        );

        emitirActualizacionGlobal('config_visual');
        res.json(updated.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// CÁLCULO DE VEREDICTO PARLAMENTARIO Y DESEMPATE AUTOMÁTICO
// =========================================================================
async function evaluarYGuardarVeredictoVotacion(idVotacion) {
    const votRes = await pool.query('SELECT * FROM votaciones WHERE id_votacion = $1', [idVotacion]);
    if (votRes.rows.length === 0) return null;
    const vot = votRes.rows[0];

    const votosRes = await pool.query('SELECT opcion FROM votos WHERE id_votacion = $1', [idVotacion]);
    const si = votosRes.rows.filter((v) => v.opcion === 'SI').length;
    const no = votosRes.rows.filter((v) => v.opcion === 'NO').length;
    const abs = votosRes.rows.filter((v) => v.opcion === 'ABSTENCION').length;
    const total = votosRes.rows.length;
    const ronda = parseInt(vot.ronda_numero, 10) || 1;

    let resultado_final = '';
    let mensaje_veredicto = '';
    let nuevoEstadoProyecto = null;

    if (total === 0) {
        resultado_final = 'ARCHIVADA_SIN_VOTOS';
        mensaje_veredicto = 'La urna cerró sin votos registrados. Por falta de pronunciamiento afirmativo, la proposición / proyecto será ARCHIVADO.';
        nuevoEstadoProyecto = 'Archivado';
    } else if (si > no && si > abs) {
        resultado_final = 'ACEPTADA';
        mensaje_veredicto = `¡PROPOSICIÓN / PROYECTO ACEPTADO! (${si} votos SÍ vs. ${no} NO y ${abs} Abstenciones). Se tomará en cuenta la proposición y será añadida oficialmente al trámite del Concejo.`;
        nuevoEstadoProyecto = 'Aprobado';
    } else if (no > si && no >= abs) {
        resultado_final = 'RECHAZADA';
        mensaje_veredicto = `PROPOSICIÓN / PROYECTO RECHAZADO (${no} votos NO vs. ${si} SÍ y ${abs} Abstenciones). Al perder la votación, la iniciativa será ARCHIVADA.`;
        nuevoEstadoProyecto = 'Archivado';
    } else if (abs > si && abs > no) {
        resultado_final = 'ARCHIVADA_ABSTENCION';
        mensaje_veredicto = `GANÓ LA ABSTENCIÓN (${abs} Abstenciones vs. ${si} SÍ y ${no} NO). Al no obtener mayoría afirmativa, la proposición / proyecto será ARCHIVADO.`;
        nuevoEstadoProyecto = 'Archivado';
    } else if (si === no && si > 0) {
        if (ronda < 2) {
            resultado_final = 'EMPATE_REPETIR';
            mensaje_veredicto = `EMPATE EN PRIMERA VOTACIÓN (${si} votos SÍ vs. ${no} votos NO). Conforme al reglamento, se debe repetir nuevamente la elección.`;
        } else {
            resultado_final = 'ARCHIVADA_SEGUNDO_EMPATE';
            mensaje_veredicto = `SEGUNDO EMPATE CONSECUTIVO (${si} votos SÍ vs. ${no} votos NO). Al persistir el empate tras repetir la elección, la proposición / proyecto se ARCHIVA definitivamente.`;
            nuevoEstadoProyecto = 'Archivado';
        }
    } else {
        resultado_final = 'ARCHIVADA_SIN_MAYORIA';
        mensaje_veredicto = `NO SE ALCANZÓ MAYORÍA AFIRMATIVA (${si} SÍ, ${no} NO, ${abs} Abstenciones). Por reglamento, la iniciativa será ARCHIVADA.`;
        nuevoEstadoProyecto = 'Archivado';
    }

    const updated = await pool.query(
        `UPDATE votaciones
         SET estado = 'Cerrada',
             fecha_cierre = COALESCE(fecha_cierre, NOW()),
             resultado_final = $1,
             mensaje_veredicto = $2
         WHERE id_votacion = $3
         RETURNING *`,
        [resultado_final, mensaje_veredicto, idVotacion]
    );

    if (vot.id_proyecto && nuevoEstadoProyecto) {
        await pool.query(
            'UPDATE proyectos SET estado = $1 WHERE id_proyecto = $2',
            [nuevoEstadoProyecto, vot.id_proyecto]
        );
        emitirActualizacionGlobal('proyectos');
    }

    return updated.rows[0];
}

// =========================================================================
// 1. GESTIÓN DE CONCEJALES
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
// 2. SESIONES LIBRES Y QUÓRUM (EXCLUSIVO ADMINISTRATIVO PARA EDICIÓN)
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

// Quórum solo visible y editable por Administrador
app.get('/api/asistencias/:id_sesion', verificarAdmin, async (req, res) => {
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
// 3. PROYECTOS DE ACUERDO Y PROPOSICIONES (VISIBILIDAD PÚBLICA Y PRIVADA)
// =========================================================================
app.get('/api/proyectos', async (req, res) => {
    const esAdmin = esTokenAdminValido(req.headers['x-admin-token']);
    const esConcejal = esTokenConcejalValido(req.headers['x-concejal-token']);

    try {
        await asegurarTablasSistema();
        // Admin y Concejales autenticados pueden ver tanto Públicos como Privados.
        // Usuarios externos sin sesión solo ven los Públicos.
        const whereClause = (esAdmin || esConcejal)
            ? ''
            : `WHERE COALESCE(p.visible_publico, TRUE) = TRUE`;

        const result = await pool.query(`
            SELECT p.*,
                   COALESCE(p.visible_publico, TRUE) AS visible_publico,
                   CASE WHEN COALESCE(p.visible_publico, TRUE) THEN 'PUBLICO' ELSE 'PRIVADO' END AS visibilidad_etiqueta,
                   COALESCE(i.nombre_completo, 'Mesa Directiva / Bancada') AS autor, 
                   COALESCE(c.nombre, 'Plenaria') AS comision
            FROM proyectos p
            LEFT JOIN integrantes i ON p.id_autor = i.id_integrante
            LEFT JOIN comisiones c ON p.id_comision_asignada = c.id_comision
            ${whereClause}
            ORDER BY p.id_proyecto ASC
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
        visible_publico,
        archivo_nombre,
        archivo_contenido 
    } = req.body;

    if (!codigo_radicado || !titulo) {
        return res.status(400).json({ error: 'Código y título son obligatorios.' });
    }
    try {
        await asegurarTablasSistema();
        const comisionId = id_comision_asignada ? parseInt(id_comision_asignada, 10) : null;
        const autorId = id_autor ? parseInt(id_autor, 10) : null;
        const esPublico = visible_publico !== undefined ? Boolean(visible_publico) : true;

        const result = await pool.query(
            `INSERT INTO proyectos (
                codigo_radicado, titulo, descripcion, id_autor, id_comision_asignada, 
                tipo_documento, archivo_nombre, archivo_contenido, visible_publico
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
                codigo_radicado.trim(), 
                titulo.trim(), 
                descripcion || '', 
                autorId, 
                comisionId,
                tipo_documento || 'Proyecto de Acuerdo',
                archivo_nombre || null,
                archivo_contenido || null,
                esPublico
            ]
        );
        emitirActualizacionGlobal('proyectos');
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Concejal sube proposición usando su sesión única (sin volver a loguearse)
app.post('/api/proyectos/concejal', verificarConcejal, async (req, res) => {
    const {
        titulo,
        descripcion,
        id_comision_asignada,
        visible_publico,
        archivo_nombre,
        archivo_contenido
    } = req.body;

    if (!titulo || !titulo.trim()) {
        return res.status(400).json({ error: 'El título o asunto de la proposición es obligatorio.' });
    }

    try {
        await asegurarTablasSistema();
        const concejal = req.concejalUsuario;

        const seqRes = await pool.query(`
            SELECT COUNT(*)::INTEGER + 1 AS turno
            FROM proyectos
            WHERE tipo_documento = 'Proposición'
        `);
        const numeroOrden = seqRes.rows[0].turno;
        const codigoAuto = `PROP-${String(numeroOrden).padStart(3, '0')}`;
        const comisionId = (id_comision_asignada === '' || id_comision_asignada === undefined || id_comision_asignada === null)
            ? null
            : parseInt(id_comision_asignada, 10);
        const esPublico = visible_publico !== undefined ? Boolean(visible_publico) : false;

        const result = await pool.query(
            `INSERT INTO proyectos (
                codigo_radicado, titulo, descripcion, id_autor, id_comision_asignada,
                tipo_documento, archivo_nombre, archivo_contenido, estado, visible_publico
             )
             VALUES ($1, $2, $3, $4, $5, 'Proposición', $6, $7, 'Radicado', $8)
             RETURNING *`,
            [
                codigoAuto,
                titulo.trim(),
                descripcion || '',
                concejal.id_integrante,
                comisionId,
                archivo_nombre || null,
                archivo_contenido || null,
                esPublico
            ]
        );

        emitirActualizacionGlobal('proyectos');
        res.status(201).json({
            ok: true,
            turno: numeroOrden,
            codigo_radicado: codigoAuto,
            autor: concejal.nombre_completo,
            visible_publico: esPublico,
            proyecto: result.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/proyectos/:id_proyecto/visibilidad', verificarAdmin, async (req, res) => {
    const { visible_publico } = req.body;
    try {
        await asegurarTablasSistema();
        const result = await pool.query(
            `UPDATE proyectos SET visible_publico = $1 WHERE id_proyecto = $2 RETURNING *`,
            [Boolean(visible_publico), req.params.id_proyecto]
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
// 4. ORDEN DE LA PALABRA (CONCEJAL PIDE TURNO CON MOTIVO / ADMIN CONTROLA)
// =========================================================================
app.get('/api/intervenciones/:id_sesion', async (req, res) => {
    const idSesion = parseInt(req.params.id_sesion, 10);
    if (isNaN(idSesion)) return res.json([]);
    try {
        await asegurarTablasSistema();
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

// Concejal solicita el uso de la palabra especificando el motivo (registrado en orden estricto de llegada)
app.post('/api/intervenciones/solicitar', verificarConcejal, async (req, res) => {
    const { id_sesion, tipo_intervencion, motivo_detalle } = req.body;
    const idSesion = parseInt(id_sesion, 10);
    const concejal = req.concejalUsuario;

    if (isNaN(idSesion)) {
        return res.status(400).json({ error: 'No hay una sesión activa seleccionada.' });
    }
    if (!tipo_intervencion || !tipo_intervencion.trim()) {
        return res.status(400).json({ error: 'Debe especificar para qué solicita el uso de la palabra.' });
    }

    try {
        await asegurarTablasSistema();

        // Evitar solicitudes duplicadas pendientes del mismo concejal en la misma sesión
        const existente = await pool.query(
            `SELECT id_intervencion, orden_turno FROM intervenciones
             WHERE id_sesion = $1 AND id_integrante = $2 AND COALESCE(estado, 'Pendiente') IN ('Pendiente', 'En Curso')`,
            [idSesion, concejal.id_integrante]
        );
        if (existente.rows.length > 0) {
            return res.status(409).json({
                error: `Ya tienes una solicitud activa en el turno #${existente.rows[0].orden_turno}.`,
            });
        }

        const ordenRes = await pool.query(
            'SELECT COALESCE(MAX(orden_turno), 0) + 1 AS siguiente FROM intervenciones WHERE id_sesion = $1',
            [idSesion]
        );
        const turnoAsignado = ordenRes.rows[0].siguiente;

        const result = await pool.query(
            `INSERT INTO intervenciones (
                id_sesion, id_integrante, tipo_intervencion, motivo_detalle, tiempo_asignado_seg, orden_turno, estado
             )
             VALUES ($1, $2, $3, $4, 180, $5, 'Pendiente') RETURNING *`,
            [
                idSesion,
                concejal.id_integrante,
                tipo_intervencion.trim(),
                (motivo_detalle && motivo_detalle.trim()) ? motivo_detalle.trim() : 'Sin observación adicional',
                turnoAsignado
            ]
        );

        emitirActualizacionGlobal('intervenciones');
        res.status(201).json({
            ok: true,
            turno: turnoAsignado,
            intervencion: result.rows[0],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Concejal cancela su propia solicitud si aún está pendiente
app.delete('/api/intervenciones/solicitar/:id_intervencion', verificarConcejal, async (req, res) => {
    const idIntv = parseInt(req.params.id_intervencion, 10);
    const concejal = req.concejalUsuario;
    try {
        const del = await pool.query(
            `DELETE FROM intervenciones
             WHERE id_intervencion = $1 AND id_integrante = $2 AND COALESCE(estado, 'Pendiente') = 'Pendiente'
             RETURNING *`,
            [idIntv, concejal.id_integrante]
        );
        if (del.rowCount === 0) {
            return res.status(400).json({ error: 'No se puede cancelar esta intervención.' });
        }
        emitirActualizacionGlobal('intervenciones');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin agrega manualmente una intervención
app.post('/api/intervenciones', verificarAdmin, async (req, res) => {
    const { id_sesion, id_integrante, tipo_intervencion, motivo_detalle, tiempo_asignado_seg } = req.body;
    try {
        await asegurarTablasSistema();
        const ordenRes = await pool.query(
            'SELECT COALESCE(MAX(orden_turno), 0) + 1 AS siguiente FROM intervenciones WHERE id_sesion = $1',
            [id_sesion]
        );
        const result = await pool.query(
            `INSERT INTO intervenciones (id_sesion, id_integrante, tipo_intervencion, motivo_detalle, tiempo_asignado_seg, orden_turno)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
                id_sesion,
                id_integrante,
                tipo_intervencion,
                motivo_detalle || '',
                parseInt(tiempo_asignado_seg, 10) || 180,
                ordenRes.rows[0].siguiente
            ]
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
// 5. SISTEMA DE VOTACIÓN NOMINAL, VEREDICTO Y REPETICIÓN POR EMPATE
// =========================================================================
async function cerrarVotacionesExpiradas() {
    await asegurarTablasSistema();
    const res = await pool.query(`
        SELECT id_votacion FROM votaciones
        WHERE estado = 'Abierta'
          AND fecha_cierre IS NOT NULL
          AND fecha_cierre <= NOW()
    `);
    if (res.rowCount > 0) {
        for (const row of res.rows) {
            await evaluarYGuardarVeredictoVotacion(row.id_votacion);
        }
        emitirActualizacionGlobal('votaciones');
    }
}

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
            `INSERT INTO votaciones (
                id_sesion, id_proyecto, titulo, descripcion, ambito, estado, duracion_seg, ronda_numero, fecha_cierre
             )
             VALUES ($1, $2, $3, $4, $5, 'Abierta', $6::INTEGER, 1, NOW() + make_interval(secs => $6::INTEGER))
             RETURNING *, GREATEST(0, EXTRACT(EPOCH FROM (fecha_cierre - NOW())))::INTEGER AS segundos_restantes`,
            [sesionVal, proyectoVal, titulo.trim(), descripcion || '', ambito || 'Plenaria', duracionVal]
        );
        emitirActualizacionGlobal('votaciones', { id_votacion: result.rows[0].id_votacion });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/votaciones/:id_votacion/repetir', verificarAdmin, async (req, res) => {
    const idVot = parseInt(req.params.id_votacion, 10);
    try {
        await asegurarTablasSistema();
        const votRes = await pool.query('SELECT * FROM votaciones WHERE id_votacion = $1', [idVot]);
        if (votRes.rows.length === 0) {
            return res.status(404).json({ error: 'Votación no encontrada.' });
        }
        const vot = votRes.rows[0];
        const rondaActual = parseInt(vot.ronda_numero, 10) || 1;
        if (rondaActual >= 2) {
            return res.status(400).json({
                error: 'Esta votación ya tuvo su segunda ronda de desempate. Por reglamento, si vuelve a empatar se archiva.',
            });
        }

        const duracionVal = Math.max(15, parseInt(vot.duracion_seg, 10) || 120);
        await pool.query('DELETE FROM votos WHERE id_votacion = $1', [idVot]);
        await pool.query('DELETE FROM votacion_registros WHERE id_votacion = $1', [idVot]);

        const updated = await pool.query(
            `UPDATE votaciones
             SET estado = 'Abierta',
                 ronda_numero = 2,
                 resultado_final = NULL,
                 mensaje_veredicto = NULL,
                 fecha_cierre = NOW() + make_interval(secs => $1::INTEGER)
             WHERE id_votacion = $2
             RETURNING *, GREATEST(0, EXTRACT(EPOCH FROM (fecha_cierre - NOW())))::INTEGER AS segundos_restantes`,
            [duracionVal, idVot]
        );

        emitirActualizacionGlobal('votaciones', { id_votacion: idVot });
        res.json({ ok: true, votacion: updated.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/votaciones/:id_votacion/estado', verificarAdmin, async (req, res) => {
    const { estado } = req.body;
    const idVot = parseInt(req.params.id_votacion, 10);
    try {
        await asegurarTablasSistema();
        let resultRow;
        if (estado === 'Abierta') {
            const result = await pool.query(
                `UPDATE votaciones 
                 SET estado = 'Abierta',
                     resultado_final = NULL,
                     mensaje_veredicto = NULL,
                     fecha_cierre = NOW() + make_interval(secs => COALESCE(duracion_seg, 120)::INTEGER)
                 WHERE id_votacion = $1 RETURNING *`,
                [idVot]
            );
            resultRow = result.rows[0];
        } else {
            await pool.query(
                `UPDATE votaciones SET estado = 'Cerrada', fecha_cierre = NOW() WHERE id_votacion = $1`,
                [idVot]
            );
            resultRow = await evaluarYGuardarVeredictoVotacion(idVot);
        }
        emitirActualizacionGlobal('votaciones', { id_votacion: idVot });
        res.json(resultRow);
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

        let votacionActual = votRes.rows[0] || null;
        if (votacionActual && votacionActual.estado === 'Cerrada' && !votacionActual.resultado_final) {
            await evaluarYGuardarVeredictoVotacion(idVotacion);
            const recarga = await pool.query(`
                SELECT v.*,
                       GREATEST(0, EXTRACT(EPOCH FROM (v.fecha_cierre - NOW())))::INTEGER AS segundos_restantes,
                       p.codigo_radicado AS proyecto_codigo,
                       p.titulo AS proyecto_titulo,
                       p.tipo_documento AS proyecto_tipo
                FROM votaciones v
                LEFT JOIN proyectos p ON v.id_proyecto = p.id_proyecto
                WHERE v.id_votacion = $1
            `, [idVotacion]);
            votacionActual = recarga.rows[0] || null;
        }

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
            votacion: votacionActual,
            votos: votosRes.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Concejal vota directamente con su sesión única ya iniciada (sin volver a loguearse)
app.post('/api/votaciones/:id_votacion/votar', verificarConcejal, async (req, res) => {
    const idVotacion = parseInt(req.params.id_votacion, 10);
    const { opcion } = req.body;
    const idInt = req.concejalUsuario.id_integrante;

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
                error: `El H.C. ${req.concejalUsuario.nombre_completo} ya registró su voto en esta urna y no puede volver a votar.`,
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