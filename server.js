const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Evitar caché en todas las rutas de la API para garantizar datos en tiempo real
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// =====================================================================
// CONEXIÓN A POSTGRESQL (NEON / RENDER) CON POOL OPTIMIZADO
// =====================================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
        ? { rejectUnauthorized: false }
        : false,
    max: 15,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000
});

// Claves institucionales
const CLAVE_ADMIN = process.env.ADMIN_PASSWORD || 'Concejo2026)';
const CLAVE_CONCEJAL = process.env.CONCEJAL_PASSWORD || 'CreerYMerecer2026';

// Sesiones activas en memoria
const sesionesActivas = new Map();

// Bloqueos instantáneos en memoria para evitar doble clic / condiciones de carrera
const solicitudesEnProceso = new Set();
const cierresEnProceso = new Set();

// Caché en memoria para logo y marca de agua
let cacheConfigVisual = null;

// Clientes conectados en tiempo real (SSE)
const clientesSSE = new Set();

function emitirEventoTiempoReal(tipo, extra = {}) {
    const payload = JSON.stringify({ tipo, timestamp: Date.now(), ...extra });
    clientesSSE.forEach((res) => {
        try {
            res.write(`data: ${payload}\n\n`);
        } catch (e) {
            clientesSSE.delete(res);
        }
    });
}

function normalizar(texto) {
    return (texto || '')
        .toString()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

// =====================================================================
// INICIALIZACIÓN, LIMPIEZA DE DUPLICADOS E ÍNDICES RÁPIDOS
// =====================================================================
async function inicializarBaseDatos() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS bancadas (
                id_bancada SERIAL PRIMARY KEY,
                nombre VARCHAR(100) UNIQUE NOT NULL
            );

            INSERT INTO bancadas (id_bancada, nombre) VALUES
                (1, 'Gobierno'),
                (2, 'Oposición'),
                (3, 'Independientes')
            ON CONFLICT (id_bancada) DO NOTHING;

            CREATE TABLE IF NOT EXISTS comisiones (
                id_comision SERIAL PRIMARY KEY,
                nombre VARCHAR(100) UNIQUE NOT NULL
            );

            INSERT INTO comisiones (id_comision, nombre) VALUES
                (1, 'Primera'),
                (2, 'Segunda')
            ON CONFLICT (id_comision) DO NOTHING;

            CREATE TABLE IF NOT EXISTS integrantes (
                id_integrante SERIAL PRIMARY KEY,
                nombre_completo VARCHAR(180) NOT NULL,
                id_bancada INT REFERENCES bancadas(id_bancada) DEFAULT 3,
                id_comision INT REFERENCES comisiones(id_comision) ON DELETE SET NULL,
                es_directiva BOOLEAN DEFAULT FALSE,
                activo BOOLEAN DEFAULT TRUE,
                creado_en TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS sesiones (
                id_sesion SERIAL PRIMARY KEY,
                titulo VARCHAR(250) NOT NULL,
                tipo_sesion VARCHAR(100) DEFAULT 'Plenaria',
                id_comision INT REFERENCES comisiones(id_comision) ON DELETE SET NULL,
                estado VARCHAR(50) DEFAULT 'Activa',
                fecha_creacion TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS asistencias (
                id_asistencia SERIAL PRIMARY KEY,
                id_sesion INT REFERENCES sesiones(id_sesion) ON DELETE CASCADE,
                id_integrante INT REFERENCES integrantes(id_integrante) ON DELETE CASCADE,
                estado VARCHAR(40) DEFAULT 'Ausente',
                hora_registro TIMESTAMP DEFAULT NOW(),
                UNIQUE(id_sesion, id_integrante)
            );

            CREATE TABLE IF NOT EXISTS intervenciones (
                id_intervencion SERIAL PRIMARY KEY,
                id_sesion INT REFERENCES sesiones(id_sesion) ON DELETE CASCADE,
                id_integrante INT REFERENCES integrantes(id_integrante) ON DELETE CASCADE,
                orden_turno INT NOT NULL,
                tipo_intervencion VARCHAR(120) DEFAULT 'Ordinaria',
                motivo_detalle TEXT,
                tiempo_asignado_seg INT DEFAULT 180,
                tiempo_usado_seg INT DEFAULT 0,
                estado VARCHAR(50) DEFAULT 'Pendiente',
                creado_en TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS proyectos (
                id_proyecto SERIAL PRIMARY KEY,
                codigo_radicado VARCHAR(80) NOT NULL,
                titulo TEXT NOT NULL,
                descripcion TEXT,
                autor VARCHAR(180) DEFAULT 'Mesa Directiva',
                id_autor INT REFERENCES integrantes(id_integrante) ON DELETE SET NULL,
                id_comision_asignada INT REFERENCES comisiones(id_comision) ON DELETE SET NULL,
                tipo_documento VARCHAR(80) DEFAULT 'Proyecto de Acuerdo',
                estado VARCHAR(50) DEFAULT 'Radicado',
                visible_publico BOOLEAN DEFAULT TRUE,
                archivo_nombre VARCHAR(255),
                archivo_contenido TEXT,
                fecha_radicacion TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS votaciones (
                id_votacion SERIAL PRIMARY KEY,
                id_sesion INT REFERENCES sesiones(id_sesion) ON DELETE SET NULL,
                id_proyecto INT REFERENCES proyectos(id_proyecto) ON DELETE SET NULL,
                titulo TEXT NOT NULL,
                descripcion TEXT,
                ambito VARCHAR(80) DEFAULT 'Plenaria',
                duracion_seg INT DEFAULT 120,
                fecha_apertura TIMESTAMPTZ DEFAULT NOW(),
                fecha_cierre TIMESTAMPTZ,
                estado VARCHAR(40) DEFAULT 'Abierta',
                ronda_numero INT DEFAULT 1,
                resultado_final VARCHAR(80),
                mensaje_veredicto TEXT
            );

            CREATE TABLE IF NOT EXISTS votos (
                id_voto SERIAL PRIMARY KEY,
                id_votacion INT REFERENCES votaciones(id_votacion) ON DELETE CASCADE,
                id_integrante INT REFERENCES integrantes(id_integrante) ON DELETE CASCADE,
                opcion VARCHAR(30) NOT NULL,
                fecha_voto TIMESTAMP DEFAULT NOW(),
                UNIQUE(id_votacion, id_integrante)
            );

            CREATE TABLE IF NOT EXISTS configuracion_visual (
                id INT PRIMARY KEY DEFAULT 1,
                logo_base64 TEXT,
                marca_agua_visible BOOLEAN DEFAULT TRUE,
                marca_agua_estilo VARCHAR(40) DEFAULT 'oro',
                marca_agua_opacidad INT DEFAULT 13,
                marca_agua_tamano INT DEFAULT 560,
                actualizado_en TIMESTAMP DEFAULT NOW()
            );

            INSERT INTO configuracion_visual (id, marca_agua_visible, marca_agua_estilo, marca_agua_opacidad, marca_agua_tamano)
            VALUES (1, TRUE, 'oro', 13, 560)
            ON CONFLICT (id) DO NOTHING;
        `);

        await client.query(`
            UPDATE integrantes SET nombre_completo = TRIM(REGEXP_REPLACE(nombre_completo, '\\s+', ' ', 'g'));

            WITH canonicos AS (
                SELECT MIN(id_integrante) AS id_principal,
                       LOWER(TRIM(nombre_completo)) AS clave_nombre
                FROM integrantes
                GROUP BY LOWER(TRIM(nombre_completo))
            ),
            duplicados AS (
                SELECT i.id_integrante AS id_dup, c.id_principal
                FROM integrantes i
                JOIN canonicos c ON LOWER(TRIM(i.nombre_completo)) = c.clave_nombre
                WHERE i.id_integrante <> c.id_principal
            )
            UPDATE proyectos p
            SET id_autor = d.id_principal
            FROM duplicados d
            WHERE p.id_autor = d.id_dup;

            DELETE FROM integrantes a
            USING integrantes b
            WHERE a.id_integrante > b.id_integrante
              AND LOWER(TRIM(a.nombre_completo)) = LOWER(TRIM(b.nombre_completo));

            CREATE UNIQUE INDEX IF NOT EXISTS idx_unico_nombre_integrante
            ON integrantes (LOWER(TRIM(nombre_completo)));

            DELETE FROM asistencias a
            USING asistencias b
            WHERE a.id_asistencia > b.id_asistencia
              AND a.id_sesion = b.id_sesion
              AND a.id_integrante = b.id_integrante;

            ALTER TABLE intervenciones ADD COLUMN IF NOT EXISTS motivo_detalle TEXT;
            ALTER TABLE intervenciones ALTER COLUMN tipo_intervencion TYPE VARCHAR(120);
            ALTER TABLE intervenciones DROP CONSTRAINT IF EXISTS intervenciones_estado_check;
            ALTER TABLE intervenciones ADD CONSTRAINT intervenciones_estado_check
                CHECK (estado IN ('Pendiente', 'En Espera', 'En Curso', 'Finalizada', 'Cancelada'));
            ALTER TABLE intervenciones DROP CONSTRAINT IF EXISTS intervenciones_tipo_intervencion_check;

            DELETE FROM intervenciones a
            USING intervenciones b
            WHERE a.id_intervencion > b.id_intervencion
              AND a.id_sesion = b.id_sesion
              AND a.id_integrante = b.id_integrante
              AND LOWER(COALESCE(a.estado, '')) NOT IN ('finalizada', 'cancelada')
              AND LOWER(COALESCE(b.estado, '')) NOT IN ('finalizada', 'cancelada');

            CREATE UNIQUE INDEX IF NOT EXISTS idx_unico_turno_pendiente
            ON intervenciones (id_sesion, id_integrante)
            WHERE estado IN ('Pendiente', 'En Espera', 'En Curso');

            DELETE FROM proyectos a
            USING proyectos b
            WHERE a.id_proyecto > b.id_proyecto
              AND LOWER(TRIM(a.codigo_radicado)) = LOWER(TRIM(b.codigo_radicado))
              AND LOWER(TRIM(a.titulo)) = LOWER(TRIM(b.titulo));

            DELETE FROM votos a
            USING votos b
            WHERE a.id_voto > b.id_voto
              AND a.id_votacion = b.id_votacion
              AND a.id_integrante = b.id_integrante;

            CREATE INDEX IF NOT EXISTS idx_asistencias_sesion ON asistencias(id_sesion);
            CREATE INDEX IF NOT EXISTS idx_intervenciones_sesion ON intervenciones(id_sesion);
            CREATE INDEX IF NOT EXISTS idx_votos_votacion ON votos(id_votacion);

            ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS visible_publico BOOLEAN DEFAULT TRUE;
            ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS archivo_nombre VARCHAR(255);
            ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS archivo_contenido TEXT;
            ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS tipo_documento VARCHAR(80) DEFAULT 'Proyecto de Acuerdo';
            ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS autor VARCHAR(180) DEFAULT 'Mesa Directiva';
            ALTER TABLE proyectos ALTER COLUMN id_autor DROP NOT NULL;

            ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS ronda_numero INT DEFAULT 1;
            ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS resultado_final VARCHAR(80);
            ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS mensaje_veredicto TEXT;
            ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS duracion_seg INT DEFAULT 120;
            ALTER TABLE votaciones ADD COLUMN IF NOT EXISTS fecha_apertura TIMESTAMPTZ DEFAULT NOW();

            ALTER TABLE configuracion_visual ADD COLUMN IF NOT EXISTS logo_base64 TEXT;
            ALTER TABLE configuracion_visual ADD COLUMN IF NOT EXISTS marca_agua_visible BOOLEAN DEFAULT TRUE;
            ALTER TABLE configuracion_visual ADD COLUMN IF NOT EXISTS marca_agua_estilo VARCHAR(40) DEFAULT 'oro';
            ALTER TABLE configuracion_visual ADD COLUMN IF NOT EXISTS marca_agua_opacidad INT DEFAULT 13;
            ALTER TABLE configuracion_visual ADD COLUMN IF NOT EXISTS marca_agua_tamano INT DEFAULT 560;
            ALTER TABLE configuracion_visual ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMP DEFAULT NOW();
        `);

        const cfgRes = await client.query('SELECT * FROM configuracion_visual WHERE id = 1');
        if (cfgRes.rows.length > 0) {
            cacheConfigVisual = cfgRes.rows[0];
        }

        console.log('✅ Base de datos limpia, indexada y configuración visual lista.');
    } catch (err) {
        console.error('❌ Error al inicializar PostgreSQL:', err);
    } finally {
        client.release();
    }
}

// =====================================================================
// MIDDLEWARES DE AUTENTICACIÓN POR ROL
// =====================================================================
function verificarAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    const sesion = token ? sesionesActivas.get(token) : null;
    if (!sesion || sesion.rol !== 'admin') {
        return res.status(401).json({ error: 'Acceso denegado. Se requiere sesión de Administrador.' });
    }
    req.admin = sesion.usuario;
    next();
}

function verificarConcejal(req, res, next) {
    const token = req.headers['x-concejal-token'];
    const sesion = token ? sesionesActivas.get(token) : null;
    if (!sesion || sesion.rol !== 'concejal') {
        return res.status(401).json({ error: 'Acceso denegado. Debe iniciar sesión como Honorable Concejal.' });
    }
    req.concejal = sesion.usuario;
    next();
}

function obtenerUsuarioOpcional(req) {
    const adminToken = req.headers['x-admin-token'];
    if (adminToken && sesionesActivas.has(adminToken)) {
        return sesionesActivas.get(adminToken);
    }
    const concejalToken = req.headers['x-concejal-token'];
    if (concejalToken && sesionesActivas.has(concejalToken)) {
        return sesionesActivas.get(concejalToken);
    }
    return null;
}

// =====================================================================
// 1. AUTENTICACIÓN ÚNICA (ADMIN Y CONCEJAL)
// =====================================================================
app.post('/api/sesion/login', async (req, res) => {
    try {
        const { rol, primer_nombre, primer_apellido, nombre_admin, cargo_admin, password } = req.body;

        if (rol === 'admin') {
            if (!nombre_admin || !nombre_admin.trim()) {
                return res.status(400).json({ error: 'Debe ingresar su nombre completo.' });
            }
            if ((password || '').trim() !== CLAVE_ADMIN) {
                return res.status(401).json({ error: 'Clave institucional administrativa incorrecta.' });
            }

            const token = crypto.randomBytes(24).toString('hex');
            const usuario = {
                nombre_admin: nombre_admin.trim(),
                cargo_admin: (cargo_admin || 'Secretaría General').trim()
            };
            sesionesActivas.set(token, { rol: 'admin', usuario });
            return res.json({ rol: 'admin', token, usuario });
        }

        if (rol === 'concejal') {
            if (!primer_nombre || !primer_apellido || !password) {
                return res.status(400).json({ error: 'Ingrese primer nombre, primer apellido y contraseña.' });
            }
            if (password.trim() !== CLAVE_CONCEJAL && password.trim() !== CLAVE_ADMIN) {
                return res.status(401).json({ error: 'Contraseña de Honorable Concejal incorrecta.' });
            }

            const result = await pool.query(`
                SELECT i.id_integrante, i.nombre_completo, i.id_bancada, i.id_comision, i.es_directiva,
                       COALESCE(b.nombre, 'Independientes') AS bancada,
                       COALESCE(c.nombre, 'Sin Comisión') AS comision
                FROM integrantes i
                LEFT JOIN bancadas b ON i.id_bancada = b.id_bancada
                LEFT JOIN comisiones c ON i.id_comision = c.id_comision
                WHERE i.activo = TRUE
                ORDER BY i.id_integrante ASC
            `);

            const nomBuscado = normalizar(primer_nombre);
            const apeBuscado = normalizar(primer_apellido);

            const encontrado = result.rows.find((row) => {
                const tokens = normalizar(row.nombre_completo).split(/\s+/);
                const coincideNombre = tokens[0] === nomBuscado || tokens.includes(nomBuscado);
                const coincideApellido = tokens.includes(apeBuscado) && apeBuscado !== nomBuscado;
                return coincideNombre && coincideApellido;
            });

            if (!encontrado) {
                return res.status(404).json({
                    error: `No se encontró ninguna curul acreditada para "${primer_nombre.trim()} ${primer_apellido.trim()}". Verifique con Secretaría General.`
                });
            }

            const token = crypto.randomBytes(24).toString('hex');
            sesionesActivas.set(token, { rol: 'concejal', usuario: encontrado });
            return res.json({ rol: 'concejal', token, usuario: encontrado });
        }

        return res.status(400).json({ error: 'Rol de acceso no válido.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sesion/verificar', (req, res) => {
    const sesion = obtenerUsuarioOpcional(req);
    if (!sesion) {
        return res.status(401).json({ error: 'Sesión no válida o expirada.' });
    }
    res.json({ rol: sesion.rol, usuario: sesion.usuario });
});

app.post('/api/sesion/salir', (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    const concejalToken = req.headers['x-concejal-token'];
    if (adminToken) sesionesActivas.delete(adminToken);
    if (concejalToken) sesionesActivas.delete(concejalToken);
    res.json({ ok: true });
});

// =====================================================================
// 2. CANAL DE EVENTOS EN TIEMPO REAL (SSE) Y CONFIGURACIÓN VISUAL
// =====================================================================
app.get('/api/eventos', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ tipo: 'conectado' })}\n\n`);
    clientesSSE.add(res);

    const keepAlive = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch (e) {
            clearInterval(keepAlive);
            clientesSSE.delete(res);
        }
    }, 20000);

    req.on('close', () => {
        clearInterval(keepAlive);
        clientesSSE.delete(res);
    });
});

app.get('/api/configuracion-visual', async (req, res) => {
    try {
        if (cacheConfigVisual && cacheConfigVisual.id) {
            return res.json(cacheConfigVisual);
        }

        await pool.query(`
            INSERT INTO configuracion_visual (id, marca_agua_visible, marca_agua_estilo, marca_agua_opacidad, marca_agua_tamano)
            VALUES (1, TRUE, 'oro', 13, 560)
            ON CONFLICT (id) DO NOTHING
        `);
        const result = await pool.query('SELECT * FROM configuracion_visual WHERE id = 1');
        cacheConfigVisual = result.rows[0] || {
            id: 1,
            logo_base64: null,
            marca_agua_visible: true,
            marca_agua_estilo: 'oro',
            marca_agua_opacidad: 13,
            marca_agua_tamano: 560
        };
        res.json(cacheConfigVisual);
    } catch (err) {
        console.error('Error leyendo configuracion_visual:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/configuracion-visual', verificarAdmin, async (req, res) => {
    try {
        const {
            logo_base64,
            marca_agua_visible,
            marca_agua_estilo,
            marca_agua_opacidad,
            marca_agua_tamano
        } = req.body;

        await pool.query(`
            INSERT INTO configuracion_visual (id, marca_agua_visible, marca_agua_estilo, marca_agua_opacidad, marca_agua_tamano)
            VALUES (1, TRUE, 'oro', 13, 560)
            ON CONFLICT (id) DO NOTHING
        `);

        const actualRes = await pool.query('SELECT * FROM configuracion_visual WHERE id = 1');
        const actual = actualRes.rows[0] || {};

        const nuevoLogo = logo_base64 !== undefined ? logo_base64 : actual.logo_base64;
        const nuevaVis = marca_agua_visible !== undefined
            ? Boolean(marca_agua_visible)
            : (actual.marca_agua_visible !== null ? Boolean(actual.marca_agua_visible) : true);
        const nuevoEstilo = marca_agua_estilo !== undefined
            ? marca_agua_estilo
            : (actual.marca_agua_estilo || 'oro');
        const nuevaOpac = marca_agua_opacidad !== undefined
            ? parseInt(marca_agua_opacidad, 10)
            : (actual.marca_agua_opacidad ?? 13);
        const nuevoTam = marca_agua_tamano !== undefined
            ? parseInt(marca_agua_tamano, 10)
            : (actual.marca_agua_tamano ?? 560);

        const updated = await pool.query(`
            INSERT INTO configuracion_visual (
                id, logo_base64, marca_agua_visible, marca_agua_estilo,
                marca_agua_opacidad, marca_agua_tamano, actualizado_en
            )
            VALUES (1, $1, $2, $3, $4, $5, NOW())
            ON CONFLICT (id) DO UPDATE SET
                logo_base64 = EXCLUDED.logo_base64,
                marca_agua_visible = EXCLUDED.marca_agua_visible,
                marca_agua_estilo = EXCLUDED.marca_agua_estilo,
                marca_agua_opacidad = EXCLUDED.marca_agua_opacidad,
                marca_agua_tamano = EXCLUDED.marca_agua_tamano,
                actualizado_en = NOW()
            RETURNING *
        `, [nuevoLogo, nuevaVis, nuevoEstilo, nuevaOpac, nuevoTam]);

        cacheConfigVisual = updated.rows[0];
        res.json(cacheConfigVisual);
        emitirEventoTiempoReal('config_visual');
    } catch (err) {
        console.error('Error guardando configuracion_visual:', err);
        res.status(500).json({ error: 'Error al guardar el logo en PostgreSQL: ' + err.message });
    }
});

// =====================================================================
// 3. INTEGRANTES / CURULES
// =====================================================================
app.get('/api/integrantes', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT ON (LOWER(TRIM(i.nombre_completo)))
                   i.id_integrante, i.nombre_completo, i.id_bancada, i.id_comision, i.es_directiva,
                   COALESCE(b.nombre, 'Independientes') AS bancada,
                   COALESCE(c.nombre, 'Sin Comisión') AS comision
            FROM integrantes i
            LEFT JOIN bancadas b ON i.id_bancada = b.id_bancada
            LEFT JOIN comisiones c ON i.id_comision = c.id_comision
            WHERE i.activo = TRUE
            ORDER BY LOWER(TRIM(i.nombre_completo)), i.id_integrante ASC
        `);

        const ordenados = result.rows.sort((a, b) => {
            if (a.es_directiva !== b.es_directiva) return b.es_directiva ? 1 : -1;
            return a.nombre_completo.localeCompare(b.nombre_completo, 'es');
        });

        res.json(ordenados);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/integrantes', verificarAdmin, async (req, res) => {
    try {
        const { nombre_completo, id_bancada, id_comision, es_directiva, id_sesion } = req.body;
        if (!nombre_completo || !nombre_completo.trim()) {
            return res.status(400).json({ error: 'El nombre completo es obligatorio.' });
        }

        const nombreLimpio = nombre_completo.trim().replace(/\s+/g, ' ');
        const comId = id_comision ? parseInt(id_comision, 10) : null;
        const banId = id_bancada ? parseInt(id_bancada, 10) : 3;

        const existe = await pool.query(
            'SELECT id_integrante FROM integrantes WHERE LOWER(TRIM(nombre_completo)) = LOWER($1)',
            [nombreLimpio]
        );
        if (existe.rows.length > 0) {
            return res.status(400).json({ error: `La curul de "${nombreLimpio}" ya está registrada.` });
        }

        const inserted = await pool.query(`
            INSERT INTO integrantes (nombre_completo, id_bancada, id_comision, es_directiva)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [nombreLimpio, banId, comId, Boolean(es_directiva)]);

        const nuevo = inserted.rows[0];

        if (id_sesion) {
            const sesRes = await pool.query('SELECT id_comision FROM sesiones WHERE id_sesion = $1', [id_sesion]);
            if (sesRes.rows.length > 0) {
                const comSesion = sesRes.rows[0].id_comision;
                if (!comSesion || comSesion === comId) {
                    await pool.query(`
                        INSERT INTO asistencias (id_sesion, id_integrante, estado)
                        VALUES ($1, $2, 'Ausente')
                        ON CONFLICT (id_sesion, id_integrante) DO NOTHING
                    `, [id_sesion, nuevo.id_integrante]);
                }
            }
        }

        res.status(201).json(nuevo);
        emitirEventoTiempoReal('integrantes');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/integrantes/:id', verificarAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre_completo, id_bancada, id_comision, es_directiva } = req.body;
        const comId = id_comision ? parseInt(id_comision, 10) : null;
        const banId = id_bancada ? parseInt(id_bancada, 10) : 3;
        const nombreLimpio = nombre_completo.trim().replace(/\s+/g, ' ');

        const updated = await pool.query(`
            UPDATE integrantes
            SET nombre_completo = $1, id_bancada = $2, id_comision = $3, es_directiva = $4
            WHERE id_integrante = $5
            RETURNING *
        `, [nombreLimpio, banId, comId, Boolean(es_directiva), id]);

        res.json(updated.rows[0]);
        emitirEventoTiempoReal('integrantes');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/integrantes/:id', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM integrantes WHERE id_integrante = $1', [req.params.id]);
        res.json({ ok: true });
        emitirEventoTiempoReal('integrantes');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================================================
// 4. SESIONES Y LLAMADO A LISTA / QUÓRUM
// =====================================================================
app.get('/api/sesiones', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM sesiones ORDER BY id_sesion DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sesiones', verificarAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { titulo, tipo_sesion, id_comision } = req.body;
        const comId = id_comision ? parseInt(id_comision, 10) : null;

        const sesRes = await client.query(`
            INSERT INTO sesiones (titulo, tipo_sesion, id_comision)
            VALUES ($1, $2, $3)
            RETURNING *
        `, [titulo.trim(), (tipo_sesion || 'Plenaria').trim(), comId]);

        const nuevaSesion = sesRes.rows[0];

        const intQuery = comId
            ? await client.query('SELECT DISTINCT id_integrante FROM integrantes WHERE activo = TRUE AND id_comision = $1', [comId])
            : await client.query('SELECT DISTINCT id_integrante FROM integrantes WHERE activo = TRUE');

        for (const row of intQuery.rows) {
            await client.query(`
                INSERT INTO asistencias (id_sesion, id_integrante, estado)
                VALUES ($1, $2, 'Ausente')
                ON CONFLICT (id_sesion, id_integrante) DO NOTHING
            `, [nuevaSesion.id_sesion, row.id_integrante]);
        }

        await client.query('COMMIT');
        res.status(201).json(nuevaSesion);
        emitirEventoTiempoReal('sesiones');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.delete('/api/sesiones/:id', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM sesiones WHERE id_sesion = $1', [req.params.id]);
        res.json({ ok: true });
        emitirEventoTiempoReal('sesiones');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/asistencias/:id_sesion', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT ON (a.id_integrante)
                   a.id_asistencia, a.id_sesion, a.id_integrante, a.estado,
                   i.nombre_completo, i.es_directiva,
                   COALESCE(b.nombre, 'Independientes') AS bancada,
                   COALESCE(c.nombre, 'Sin Comisión') AS comision
            FROM asistencias a
            JOIN integrantes i ON a.id_integrante = i.id_integrante
            LEFT JOIN bancadas b ON i.id_bancada = b.id_bancada
            LEFT JOIN comisiones c ON i.id_comision = c.id_comision
            WHERE a.id_sesion = $1 AND i.activo = TRUE
            ORDER BY a.id_integrante, a.id_asistencia ASC
        `, [req.params.id_sesion]);

        const ordenados = result.rows.sort((a, b) => {
            if (a.es_directiva !== b.es_directiva) return b.es_directiva ? 1 : -1;
            return a.nombre_completo.localeCompare(b.nombre_completo, 'es');
        });

        res.json(ordenados);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/asistencias/:id_asistencia', verificarAdmin, async (req, res) => {
    try {
        const { estado } = req.body;
        const updated = await pool.query(
            'UPDATE asistencias SET estado = $1, hora_registro = NOW() WHERE id_asistencia = $2 RETURNING id_asistencia, estado',
            [estado, req.params.id_asistencia]
        );
        res.json(updated.rows[0] || { ok: true });
        emitirEventoTiempoReal('asistencias');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/asistencias/sesion/:id_sesion/todos-presentes', verificarAdmin, async (req, res) => {
    try {
        await pool.query(
            "UPDATE asistencias SET estado = 'Presente', hora_registro = NOW() WHERE id_sesion = $1",
            [req.params.id_sesion]
        );
        res.json({ ok: true });
        emitirEventoTiempoReal('asistencias');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================================================
// 5. USO DE LA PALABRA (ORDEN DE LLEGADA SIN DUPLICADOS)
// =====================================================================
app.get('/api/intervenciones/:id_sesion', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT ON (iv.id_intervencion)
                   iv.id_intervencion, iv.id_sesion, iv.id_integrante, iv.orden_turno,
                   iv.tipo_intervencion, iv.motivo_detalle, iv.tiempo_asignado_seg,
                   iv.tiempo_usado_seg, iv.estado,
                   i.nombre_completo,
                   COALESCE(b.nombre, 'Independientes') AS bancada,
                   COALESCE(c.nombre, 'Sin Comisión') AS comision
            FROM intervenciones iv
            JOIN integrantes i ON iv.id_integrante = i.id_integrante
            LEFT JOIN bancadas b ON i.id_bancada = b.id_bancada
            LEFT JOIN comisiones c ON i.id_comision = c.id_comision
            WHERE iv.id_sesion = $1
            ORDER BY iv.id_intervencion ASC
        `, [req.params.id_sesion]);

        const ordenados = result.rows
            .sort((a, b) => a.orden_turno - b.orden_turno || a.id_intervencion - b.id_intervencion)
            .map((fila, idx) => ({
                ...fila,
                orden_turno: idx + 1
            }));

        res.json(ordenados);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/intervenciones/solicitar', verificarConcejal, async (req, res) => {
    const id_integrante = req.concejal.id_integrante;
    const llaveBloqueo = `${req.body.id_sesion}-${id_integrante}`;

    if (solicitudesEnProceso.has(llaveBloqueo)) {
        return res.status(429).json({ error: 'Ya se está procesando tu solicitud de turno.' });
    }
    solicitudesEnProceso.add(llaveBloqueo);

    try {
        const { id_sesion, tipo_intervencion, motivo_detalle } = req.body;
        if (!id_sesion) {
            return res.status(400).json({ error: 'No hay ninguna sesión activa seleccionada.' });
        }
        if (!tipo_intervencion || !tipo_intervencion.trim()) {
            return res.status(400).json({ error: 'Debe seleccionar el motivo de su intervención.' });
        }

        const existente = await pool.query(`
            SELECT id_intervencion, orden_turno
            FROM intervenciones
            WHERE id_sesion = $1 AND id_integrante = $2
              AND LOWER(COALESCE(estado, '')) NOT IN ('finalizada', 'cancelada')
        `, [id_sesion, id_integrante]);

        if (existente.rows.length > 0) {
            return res.status(400).json({
                error: `Ya tienes una solicitud activa en esta sesión.`
            });
        }

        const tipoNorm = normalizar(tipo_intervencion);
        let tiempoSeg = 180;
        if (tipoNorm.includes('vocero')) tiempoSeg = 300;
        else if (tipoNorm.includes('replica')) tiempoSeg = 120;
        else if (tipoNorm.includes('mocion')) tiempoSeg = 60;

        const maxRes = await pool.query(
            'SELECT COALESCE(MAX(orden_turno), 0) + 1 AS siguiente FROM intervenciones WHERE id_sesion = $1',
            [id_sesion]
        );
        const siguienteTurno = maxRes.rows[0].siguiente;

        const inserted = await pool.query(`
            INSERT INTO intervenciones (id_sesion, id_integrante, orden_turno, tipo_intervencion, motivo_detalle, tiempo_asignado_seg, estado)
            VALUES ($1, $2, $3, $4, $5, $6, 'Pendiente')
            RETURNING *
        `, [
            id_sesion,
            id_integrante,
            siguienteTurno,
            tipo_intervencion.trim(),
            (motivo_detalle || '').trim() || null,
            tiempoSeg
        ]);

        const activosRes = await pool.query(
            "SELECT COUNT(*)::int AS pos FROM intervenciones WHERE id_sesion = $1 AND id_intervencion <= $2",
            [id_sesion, inserted.rows[0].id_intervencion]
        );

        res.status(201).json({ turno: activosRes.rows[0].pos, intervencion: inserted.rows[0] });
        emitirEventoTiempoReal('intervenciones');
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Ya tienes una solicitud de turno activa en esta sesión.' });
        }
        res.status(500).json({ error: err.message });
    } finally {
        solicitudesEnProceso.delete(llaveBloqueo);
    }
});

app.delete('/api/intervenciones/solicitar/:id', verificarConcejal, async (req, res) => {
    try {
        const { id } = req.params;
        const id_integrante = req.concejal.id_integrante;

        const check = await pool.query(
            'SELECT * FROM intervenciones WHERE id_intervencion = $1 AND id_integrante = $2',
            [id, id_integrante]
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Turno no encontrado o no pertenece a su curul.' });
        }
        if (check.rows[0].estado !== 'Pendiente' && check.rows[0].estado !== 'En Espera') {
            return res.status(400).json({ error: 'Solo se pueden cancelar turnos que aún estén pendientes.' });
        }

        await pool.query('DELETE FROM intervenciones WHERE id_intervencion = $1', [id]);
        res.json({ ok: true });
        emitirEventoTiempoReal('intervenciones');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/intervenciones', verificarAdmin, async (req, res) => {
    try {
        const { id_sesion, id_integrante, tipo_intervencion, tiempo_asignado_seg, motivo_detalle } = req.body;
        const maxRes = await pool.query(
            'SELECT COALESCE(MAX(orden_turno), 0) + 1 AS siguiente FROM intervenciones WHERE id_sesion = $1',
            [id_sesion]
        );
        const siguienteTurno = maxRes.rows[0].siguiente;

        const inserted = await pool.query(`
            INSERT INTO intervenciones (id_sesion, id_integrante, orden_turno, tipo_intervencion, motivo_detalle, tiempo_asignado_seg, estado)
            VALUES ($1, $2, $3, $4, $5, $6, 'Pendiente')
            RETURNING *
        `, [
            id_sesion,
            id_integrante,
            siguienteTurno,
            (tipo_intervencion || 'Ordinaria').trim(),
            motivo_detalle || null,
            parseInt(tiempo_asignado_seg, 10) || 180
        ]);

        res.status(201).json(inserted.rows[0]);
        emitirEventoTiempoReal('intervenciones');
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Ese concejal ya tiene un turno activo en esta sesión.' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/intervenciones/:id', verificarAdmin, async (req, res) => {
    try {
        const { tiempo_usado_seg, estado } = req.body;
        await pool.query(
            'UPDATE intervenciones SET tiempo_usado_seg = $1, estado = $2 WHERE id_intervencion = $3',
            [tiempo_usado_seg || 0, estado || 'En Curso', req.params.id]
        );
        res.json({ ok: true });
        emitirEventoTiempoReal('intervenciones');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/intervenciones/:id', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM intervenciones WHERE id_intervencion = $1', [req.params.id]);
        res.json({ ok: true });
        emitirEventoTiempoReal('intervenciones');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================================================
// 6. PROYECTOS Y PROPOSICIONES
// =====================================================================
app.get('/api/proyectos', async (req, res) => {
    try {
        const sesion = obtenerUsuarioOpcional(req);
        const puedeVerPrivados = sesion && (sesion.rol === 'admin' || sesion.rol === 'concejal');

        const query = `
            SELECT DISTINCT ON (p.id_proyecto)
                   p.id_proyecto, p.codigo_radicado, p.titulo, p.descripcion,
                   COALESCE(i.nombre_completo, p.autor, 'Mesa Directiva') AS autor,
                   p.id_autor, p.id_comision_asignada,
                   COALESCE(c.nombre, 'Plenaria') AS comision,
                   p.tipo_documento, p.estado, p.visible_publico,
                   p.archivo_nombre, p.archivo_contenido, p.fecha_radicacion
            FROM proyectos p
            LEFT JOIN integrantes i ON p.id_autor = i.id_integrante
            LEFT JOIN comisiones c ON p.id_comision_asignada = c.id_comision
            ${puedeVerPrivados ? '' : 'WHERE p.visible_publico = TRUE'}
            ORDER BY p.id_proyecto ASC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proyectos/concejal', verificarConcejal, async (req, res) => {
    try {
        const {
            titulo,
            descripcion,
            id_comision_asignada,
            visible_publico,
            archivo_nombre,
            archivo_contenido
        } = req.body;

        if (!titulo || !titulo.trim()) {
            return res.status(400).json({ error: 'El título de la proposición es obligatorio.' });
        }

        const countRes = await pool.query("SELECT COUNT(*)::int AS total FROM proyectos WHERE tipo_documento = 'Proposición'");
        const consecutivo = String(countRes.rows[0].total + 1).padStart(3, '0');
        const codigo_radicado = `PROP-${consecutivo}-${new Date().getFullYear()}`;
        const comId = id_comision_asignada ? parseInt(id_comision_asignada, 10) : null;
        const esPublico = visible_publico === true || visible_publico === 'true';

        const inserted = await pool.query(`
            INSERT INTO proyectos (
                codigo_radicado, titulo, descripcion, autor, id_autor,
                id_comision_asignada, tipo_documento, estado, visible_publico,
                archivo_nombre, archivo_contenido
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'Proposición', 'Radicado', $7, $8, $9)
            RETURNING *
        `, [
            codigo_radicado,
            titulo.trim(),
            (descripcion || '').trim(),
            req.concejal.nombre_completo,
            req.concejal.id_integrante,
            comId,
            esPublico,
            archivo_nombre || null,
            archivo_contenido || null
        ]);

        res.status(201).json({ codigo_radicado, proyecto: inserted.rows[0] });
        emitirEventoTiempoReal('proyectos');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proyectos', verificarAdmin, async (req, res) => {
    try {
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

        let nombreAutor = 'Mesa Directiva';
        const autorId = id_autor ? parseInt(id_autor, 10) : null;
        if (autorId) {
            const auRes = await pool.query('SELECT nombre_completo FROM integrantes WHERE id_integrante = $1', [autorId]);
            if (auRes.rows.length > 0) nombreAutor = auRes.rows[0].nombre_completo;
        }

        const comId = id_comision_asignada ? parseInt(id_comision_asignada, 10) : null;
        const esPublico = visible_publico !== false && visible_publico !== 'false';

        const inserted = await pool.query(`
            INSERT INTO proyectos (
                codigo_radicado, titulo, descripcion, autor, id_autor,
                id_comision_asignada, tipo_documento, estado, visible_publico,
                archivo_nombre, archivo_contenido
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'Radicado', $8, $9, $10)
            RETURNING *
        `, [
            codigo_radicado.trim(),
            titulo.trim(),
            (descripcion || '').trim(),
            nombreAutor,
            autorId,
            comId,
            tipo_documento || 'Proyecto de Acuerdo',
            esPublico,
            archivo_nombre || null,
            archivo_contenido || null
        ]);

        res.status(201).json(inserted.rows[0]);
        emitirEventoTiempoReal('proyectos');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/proyectos/:id/estado', verificarAdmin, async (req, res) => {
    try {
        await pool.query('UPDATE proyectos SET estado = $1 WHERE id_proyecto = $2', [req.body.estado, req.params.id]);
        res.json({ ok: true });
        emitirEventoTiempoReal('proyectos');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/proyectos/:id/visibilidad', verificarAdmin, async (req, res) => {
    try {
        const esPublico = Boolean(req.body.visible_publico);
        await pool.query('UPDATE proyectos SET visible_publico = $1 WHERE id_proyecto = $2', [esPublico, req.params.id]);
        res.json({ ok: true });
        emitirEventoTiempoReal('proyectos');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/proyectos/:id', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM proyectos WHERE id_proyecto = $1', [req.params.id]);
        res.json({ ok: true });
        emitirEventoTiempoReal('proyectos');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================================================
// 7. SISTEMA DE VOTACIÓN NOMINAL, CRONÓMETRO DE URNA Y VEREDICTO
// =====================================================================
async function evaluarYCerrarSiExpiro(votacion) {
    if (!votacion || votacion.estado !== 'Abierta') {
        return { ...votacion, segundos_restantes: 0 };
    }

    // Cálculo sincronizado usando el reloj del servidor Node
    const apertura = new Date(votacion.fecha_apertura).getTime();
    const duracion = parseInt(votacion.duracion_seg, 10) || 120;
    const transcurridos = Math.floor((Date.now() - apertura) / 1000);
    const restantes = Math.max(0, duracion - transcurridos);

    if (restantes > 0) {
        return { ...votacion, segundos_restantes: restantes };
    }

    const cerrada = await dictaminarYCerrarVotacion(votacion.id_votacion);
    return { ...(cerrada || votacion), segundos_restantes: 0 };
}

async function dictaminarYCerrarVotacion(id_votacion) {
    const idNum = parseInt(id_votacion, 10);
    if (cierresEnProceso.has(idNum)) {
        const yaCerrada = await pool.query('SELECT * FROM votaciones WHERE id_votacion = $1', [idNum]);
        return yaCerrada.rows[0] || null;
    }
    cierresEnProceso.add(idNum);

    try {
        const votRes = await pool.query('SELECT * FROM votaciones WHERE id_votacion = $1', [idNum]);
        if (votRes.rows.length === 0) return null;
        const vot = votRes.rows[0];
        if (vot.estado === 'Cerrada') return vot;

        const votosRes = await pool.query('SELECT opcion FROM votos WHERE id_votacion = $1', [idNum]);
        const si = votosRes.rows.filter(v => v.opcion === 'SI').length;
        const no = votosRes.rows.filter(v => v.opcion === 'NO').length;
        const abs = votosRes.rows.filter(v => v.opcion === 'ABSTENCION').length;
        const ronda = parseInt(vot.ronda_numero, 10) || 1;

        let resultado_final = 'RECHAZADA';
        let mensaje_veredicto = `Resultado final: ${si} SÍ, ${no} NO, ${abs} Abstenciones. La iniciativa NO alcanzó mayoría y queda ARCHIVADA.`;
        let nuevoEstadoProyecto = 'Archivado';

        if (si > no && si > abs) {
            resultado_final = 'ACEPTADA';
            mensaje_veredicto = `Resultado final: ${si} votos por el SÍ frente a ${no} por el NO (${abs} abstenciones). Proposición APROBADA por mayoría.`;
            nuevoEstadoProyecto = 'Aprobado';
        } else if (abs > si && abs > no) {
            resultado_final = 'ARCHIVADA_ABSTENCION';
            mensaje_veredicto = `Resultado final: Prevaleció la ABSTENCIÓN (${abs} votos) sobre el SÍ (${si}) y el NO (${no}). La iniciativa queda ARCHIVADA.`;
            nuevoEstadoProyecto = 'Archivado';
        } else if (si === no) {
            if (ronda < 2) {
                resultado_final = 'EMPATE_REPETIR';
                mensaje_veredicto = `EMPATE EN PRIMERA RONDA (${si} SÍ vs. ${no} NO, ${abs} abstenciones). De acuerdo con el reglamento, debe repetirse la votación.`;
                nuevoEstadoProyecto = null;
            } else {
                resultado_final = 'ARCHIVADA_SEGUNDO_EMPATE';
                mensaje_veredicto = `SEGUNDO EMPATE CONSECUTIVO (${si} SÍ vs. ${no} NO, ${abs} abstenciones). La iniciativa queda definitivamente ARCHIVADA.`;
                nuevoEstadoProyecto = 'Archivado';
            }
        }

        const updated = await pool.query(`
            UPDATE votaciones
            SET estado = 'Cerrada',
                fecha_cierre = $1,
                resultado_final = $2,
                mensaje_veredicto = $3
            WHERE id_votacion = $4 AND estado = 'Abierta'
            RETURNING *
        `, [new Date().toISOString(), resultado_final, mensaje_veredicto, idNum]);

        if (updated.rows.length > 0) {
            if (vot.id_proyecto && nuevoEstadoProyecto) {
                await pool.query('UPDATE proyectos SET estado = $1 WHERE id_proyecto = $2', [nuevoEstadoProyecto, vot.id_proyecto]);
                emitirEventoTiempoReal('proyectos');
            }
            emitirEventoTiempoReal('votaciones');
            return updated.rows[0];
        }

        const fallback = await pool.query('SELECT * FROM votaciones WHERE id_votacion = $1', [idNum]);
        return fallback.rows[0];
    } finally {
        cierresEnProceso.delete(idNum);
    }
}

app.get('/api/votaciones', async (req, res) => {
    try {
        const { id_sesion } = req.query;
        const result = id_sesion
            ? await pool.query('SELECT * FROM votaciones WHERE id_sesion = $1 OR id_sesion IS NULL ORDER BY id_votacion DESC', [id_sesion])
            : await pool.query('SELECT * FROM votaciones ORDER BY id_votacion DESC');

        const procesadas = [];
        for (const v of result.rows) {
            procesadas.push(await evaluarYCerrarSiExpiro(v));
        }
        res.json(procesadas);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/votaciones', verificarAdmin, async (req, res) => {
    try {
        const { id_sesion, id_proyecto, titulo, descripcion, ambito, duracion_seg } = req.body;
        const proyId = id_proyecto ? parseInt(id_proyecto, 10) : null;
        const sesId = id_sesion ? parseInt(id_sesion, 10) : null;
        const duracion = parseInt(duracion_seg, 10) || 120;
        const ahoraISO = new Date().toISOString();

        const inserted = await pool.query(`
            INSERT INTO votaciones (id_sesion, id_proyecto, titulo, descripcion, ambito, duracion_seg, fecha_apertura, estado, ronda_numero)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'Abierta', 1)
            RETURNING *
        `, [sesId, proyId, titulo.trim(), (descripcion || '').trim(), ambito || 'Plenaria', duracion, ahoraISO]);

        if (proyId) {
            await pool.query("UPDATE proyectos SET estado = 'En Debate' WHERE id_proyecto = $1", [proyId]);
            emitirEventoTiempoReal('proyectos');
        }

        res.status(201).json({ ...inserted.rows[0], segundos_restantes: duracion });
        emitirEventoTiempoReal('votaciones');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/votaciones/:id/votos', async (req, res) => {
    try {
        const votRes = await pool.query(`
            SELECT v.*, p.codigo_radicado AS proyecto_codigo, p.tipo_documento AS proyecto_tipo
            FROM votaciones v
            LEFT JOIN proyectos p ON v.id_proyecto = p.id_proyecto
            WHERE v.id_votacion = $1
        `, [req.params.id]);

        if (votRes.rows.length === 0) {
            return res.status(404).json({ error: 'Votación no encontrada.' });
        }

        const votacionActualizada = await evaluarYCerrarSiExpiro(votRes.rows[0]);

        const votosRes = await pool.query(`
            SELECT DISTINCT ON (vo.id_integrante)
                   vo.id_voto, vo.id_votacion, vo.id_integrante, vo.opcion, vo.fecha_voto,
                   i.nombre_completo,
                   COALESCE(b.nombre, 'Independientes') AS bancada,
                   COALESCE(c.nombre, 'Sin Comisión') AS comision
            FROM votos vo
            JOIN integrantes i ON vo.id_integrante = i.id_integrante
            LEFT JOIN bancadas b ON i.id_bancada = b.id_bancada
            LEFT JOIN comisiones c ON i.id_comision = c.id_comision
            WHERE vo.id_votacion = $1
            ORDER BY vo.id_integrante, vo.fecha_voto ASC
        `, [req.params.id]);

        res.json({ votacion: votacionActualizada, votos: votosRes.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/votaciones/:id/votar', verificarConcejal, async (req, res) => {
    try {
        const { opcion } = req.body;
        if (!['SI', 'NO', 'ABSTENCION'].includes(opcion)) {
            return res.status(400).json({ error: 'Opción de voto no válida.' });
        }

        const votRes = await pool.query('SELECT * FROM votaciones WHERE id_votacion = $1', [req.params.id]);
        if (votRes.rows.length === 0) {
            return res.status(404).json({ error: 'La votación no existe.' });
        }

        const votActual = await evaluarYCerrarSiExpiro(votRes.rows[0]);
        if (votActual.estado !== 'Abierta') {
            return res.status(400).json({ error: 'La urna de votación ya se encuentra cerrada.' });
        }

        const id_integrante = req.concejal.id_integrante;

        if (votActual.ambito === 'Comisión Primera' && req.concejal.id_comision !== 1) {
            return res.status(403).json({ error: 'Esta votación es exclusiva de la Comisión Primera.' });
        }
        if (votActual.ambito === 'Comisión Segunda' && req.concejal.id_comision !== 2) {
            return res.status(403).json({ error: 'Esta votación es exclusiva de la Comisión Segunda.' });
        }

        const yaVoto = await pool.query(
            'SELECT id_voto FROM votos WHERE id_votacion = $1 AND id_integrante = $2',
            [req.params.id, id_integrante]
        );
        if (yaVoto.rows.length > 0) {
            return res.status(400).json({ error: 'Su curul ya depositó su único voto definitivo en esta urna.' });
        }

        await pool.query(
            'INSERT INTO votos (id_votacion, id_integrante, opcion) VALUES ($1, $2, $3)',
            [req.params.id, id_integrante, opcion]
        );

        res.status(201).json({ ok: true });
        emitirEventoTiempoReal('votos');
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Su curul ya depositó su único voto definitivo en esta urna.' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/votaciones/:id/estado', verificarAdmin, async (req, res) => {
    try {
        const { estado } = req.body;
        if (estado === 'Cerrada') {
            await dictaminarYCerrarVotacion(req.params.id);
        } else {
            await pool.query(`
                UPDATE votaciones
                SET estado = 'Abierta', fecha_apertura = $1, fecha_cierre = NULL, resultado_final = NULL, mensaje_veredicto = NULL
                WHERE id_votacion = $2
            `, [new Date().toISOString(), req.params.id]);
            emitirEventoTiempoReal('votaciones');
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/votaciones/:id/repetir', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM votos WHERE id_votacion = $1', [req.params.id]);
        await pool.query(`
            UPDATE votaciones
            SET estado = 'Abierta',
                ronda_numero = 2,
                fecha_apertura = $1,
                fecha_cierre = NULL,
                resultado_final = NULL,
                mensaje_veredicto = NULL
            WHERE id_votacion = $2
        `, [new Date().toISOString(), req.params.id]);

        res.json({ ok: true });
        emitirEventoTiempoReal('votaciones');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/votaciones/:id', verificarAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM votaciones WHERE id_votacion = $1', [req.params.id]);
        res.json({ ok: true });
        emitirEventoTiempoReal('votaciones');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================================================================
// INICIAR SERVIDOR
// =====================================================================
inicializarBaseDatos().then(() => {
    app.listen(PORT, () => {
        console.log(`🏛️  Servidor del Concejo Municipal de Ibagué corriendo en puerto ${PORT}`);
        console.log(`🔑 Clave Admin: ${CLAVE_ADMIN} | 🔑 Clave Concejal: ${CLAVE_CONCEJAL}`);
    });
});