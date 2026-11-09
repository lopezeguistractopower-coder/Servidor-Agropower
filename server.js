require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || '29879071';

// ------------------------------------------------------------------
// Configuración de notificaciones por correo (SMTP)
// ------------------------------------------------------------------
const INTERVALO_CAMBIO_ACEITE = 200;      // horas entre cambios de aceite
const HORAS_DIARIAS = 10;                 // horas de uso diario por tractor
const TOTAL_CUOTAS = 6;                   // financiamiento: 6 meses / 6 cuotas
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'servicio@agropowervenezuela.com';
const NOTIFY_DAYS_CUOTA = parseInt(process.env.NOTIFY_DAYS_CUOTA || '7', 10); // días de antelación aviso de cuota

let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_USER.indexOf('tu_correo') === -1) {
    transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
    console.log(`📧 Notificaciones por correo configuradas hacia ${NOTIFY_EMAIL}`);
} else {
    console.warn('⚠️  SMTP no configurado. Completa SMTP_USER/SMTP_PASS en .env para activar los correos.');
}

// Enviar correo de notificación (nunca lanza error fatal)
async function sendNotificationEmail(subject, htmlBody) {
    if (!transporter) {
        console.log(`[EMAIL] (SMTP no configurado) Asunto: ${subject}`);
        return false;
    }
    try {
        await transporter.sendMail({
            from: `"Agropower Console" <${process.env.SMTP_USER}>`,
            to: NOTIFY_EMAIL,
            subject,
            html: htmlBody
        });
        console.log(`📧 Correo enviado: ${subject}`);
        return true;
    } catch (err) {
        console.error('❌ Error enviando correo:', err.message);
        return false;
    }
}

// ------------------------------------------------------------------
// Helpers de fecha / cálculo
// ------------------------------------------------------------------
function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function addMonths(date, n) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + n);
    return d;
}

function daysBetween(from, to) {
    const a = startOfDay(from);
    const b = startOfDay(to);
    return Math.round((b - a) / 86400000);
}

// Fecha del tractor (puede llegar como string 'YYYY-MM-DD' o Date)
function asDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

// ------------------------------------------------------------------
// Cálculo del contador de cambio de aceite
// ------------------------------------------------------------------
function computeOilInfo(t) {
    const now = new Date();
    const entrega = asDate(t.fecha_entrega);
    const ajuste = parseInt(t.aceite_ajuste || 0, 10) || 0;

    if (!entrega || now < startOfDay(entrega)) {
        const oilHours = Math.max(0, ajuste);
        const oilDue = oilHours >= INTERVALO_CAMBIO_ACEITE;
        const oilProgressPct = Math.min(100, Math.round((oilHours / INTERVALO_CAMBIO_ACEITE) * 100));
        const remaining = Math.max(0, INTERVALO_CAMBIO_ACEITE - oilHours);
        return {
            oilHours,
            oilDue,
            oilProgressPct,
            oilDaysToChange: Math.ceil(remaining / HORAS_DIARIAS),
            oilPaused: !!t.aceite_pausado,
            oilAdjusted: ajuste,
            oilRemaining: remaining,
            oilIntervalHours: INTERVALO_CAMBIO_ACEITE,
            oilDailyHours: HORAS_DIARIAS,
            oilActive: false
        };
    }

    let inicioIntervalo = entrega;
    if (t.aceite_ultimo_cambio_at) {
        const cambio = asDate(t.aceite_ultimo_cambio_at);
        if (cambio && cambio > entrega) inicioIntervalo = cambio;
    }

    // Días pausados acumulados de intervalos anteriores
    let diasPausados = parseInt(t.aceite_pausa_dias || 0, 10) || 0;
    // Si está pausado ahora, contar el tramo desde el inicio de la pausa
    if (t.aceite_pausado && t.aceite_pausa_desde) {
        const pInicio = asDate(t.aceite_pausa_desde);
        if (pInicio) diasPausados += Math.max(0, daysBetween(pInicio, now));
    }

    const diasTotales = Math.max(0, daysBetween(inicioIntervalo, now));
    const diasActivos = Math.max(0, diasTotales - diasPausados);

    const oilHours = diasActivos * HORAS_DIARIAS + ajuste;
    const oilDue = oilHours >= INTERVALO_CAMBIO_ACEITE;
    const oilProgressPct = Math.min(100, Math.round((oilHours / INTERVALO_CAMBIO_ACEITE) * 100));
    const remaining = Math.max(0, INTERVALO_CAMBIO_ACEITE - oilHours);
    const oilDaysToChange = Math.ceil(remaining / HORAS_DIARIAS);

    return {
        oilHours: Math.max(0, oilHours),
        oilDue,
        oilProgressPct,
        oilDaysToChange,
        oilRemaining: remaining,
        oilPaused: !!t.aceite_pausado,
        oilAdjusted: ajuste,
        oilIntervalHours: INTERVALO_CAMBIO_ACEITE,
        oilDailyHours: HORAS_DIARIAS,
        oilActive: true
    };
}

// ------------------------------------------------------------------
// Cálculo del estado de financiamiento
// ------------------------------------------------------------------
function computeFinancingInfo(t) {
    const now = new Date();
    const hoy = startOfDay(now);

    const pagosRaw = Array.isArray(t.cuotas_pagos) ? t.cuotas_pagos : [];
    if (!t.tipo_venta || t.tipo_venta !== 'FINANCIADO' || !t.fecha_inicio_financiamiento) {
        return { financing: false, tipoVenta: t.tipo_venta || 'CONTADO', cuotasPagos: pagosRaw };
    }

    const inicio = asDate(t.fecha_inicio_financiamiento);
    if (!inicio) return { financing: false, tipoVenta: t.tipo_venta || 'CONTADO', cuotasPagos: pagosRaw };

    const total = parseInt(t.cuotas_total || TOTAL_CUOTAS, 10) || TOTAL_CUOTAS;
    let pagadas = pagosRaw.length;
    if (pagadas === 0) pagadas = parseInt(t.cuotas_pagadas || 0, 10) || 0;
    pagadas = Math.min(pagadas, total);
    const nextNumero = pagadas + 1;
    const monto = parseFloat(t.monto_cuota) > 0 ? parseFloat(t.monto_cuota) : Math.round((parseFloat(t.precio) / total) * 100) / 100;

    const nextDate = addMonths(inicio, nextNumero);
    const dias = daysBetween(hoy, startOfDay(nextDate));
    const vencida = dias < 0;
    const proxima = !vencida && dias <= NOTIFY_DAYS_CUOTA;

    return {
        financing: true,
        tipoVenta: 'FINANCIADO',
        total: total,
        pagadas: pagadas,
        nextNumero: nextNumero,
        montoCuota: monto,
        nextDate: nextDate.toISOString().split('T')[0],
        daysToCuota: dias,
        vencida,
        proxima,
        alDia: !vencida && !proxima,
        cuotasPagos: pagosRaw
    };
}

// Devuelve una fila con todos los campos calculados (aceite + financiamiento)
function enrichRow(r) {
    const oil = computeOilInfo(r);
    const fin = computeFinancingInfo(r);
    return { ...r, ...oil, ...fin };
}

// Plantilla HTML para aviso de cambio de aceite
function oilEmailHtml(t, info, etiqueta = 'Tractor') {
    const ref = t.vin || t.serie || '—';
    return `
    <div style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;border-radius:12px">
        <h2 style="color:#111;margin:0 0 6px">🔧 Cambio de Aceite Requerido</h2>
        <p style="color:#555;margin:0 0 16px">El ${etiqueta.toLowerCase()} ha alcanzado el intervalo de cambio de aceite.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;border-radius:8px">
            <tr><td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888">${etiqueta}</td><td style="padding:10px 14px;border-bottom:1px solid #eee;font-weight:bold;color:#111">${t.marca} ${t.modelo}</td></tr>
            <tr><td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888">Referencia</td><td style="padding:10px 14px;border-bottom:1px solid #eee;font-weight:bold;color:#111">${ref}</td></tr>
            <tr><td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888">Horas acumuladas</td><td style="padding:10px 14px;border-bottom:1px solid #eee;font-weight:bold;color:#111">${info.oilHours} h</td></tr>
            <tr><td style="padding:10px 14px;color:#888">Intervalo programado</td><td style="padding:10px 14px;font-weight:bold;color:#111">Cada ${INTERVALO_CAMBIO_ACEITE} horas</td></tr>
        </table>
        <p style="color:#777;font-size:12px;margin-top:16px">Generado automáticamente por Agropower Console.</p>
    </div>`;
}

// Plantilla HTML para aviso de cuota
function cuotaEmailHtml(t, fin, etiqueta = 'Tractor') {
    const estado = fin.vencida ? 'VENCIDA' : 'PRÓXIMA';
    const color = fin.vencida ? '#d93025' : '#b45309';
    const ref = t.vin || t.serie || '—';
    return `
    <div style="font-family:Arial,sans-serif;background:#f5f5f5;padding:20px;border-radius:12px">
        <h2 style="color:#111;margin:0 0 6px">💰 Cuota ${estado}: ${fin.nextNumero}/${fin.total}</h2>
        <p style="color:#555;margin:0 0 16px">Recordatorio de financiamiento del ${etiqueta.toLowerCase()}.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;border-radius:8px">
            <tr><td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888">${etiqueta}</td><td style="padding:10px 14px;border-bottom:1px solid #eee;font-weight:bold;color:#111">${t.marca} ${t.modelo}</td></tr>
            <tr><td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888">Referencia</td><td style="padding:10px 14px;border-bottom:1px solid #eee;font-weight:bold;color:#111">${ref}</td></tr>
            <tr><td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888">Cuota a vencer</td><td style="padding:10px 14px;border-bottom:1px solid #eee;font-weight:bold;color:${color}">#${fin.nextNumero} — $${fin.montoCuota.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
            <tr><td style="padding:10px 14px;color:#888">Fecha de vencimiento</td><td style="padding:10px 14px;font-weight:bold;color:${color}">${fin.nextDate} (${fin.daysToCuota < 0 ? Math.abs(fin.daysToCuota) + ' día(s) de retraso' : 'en ' + fin.daysToCuota + ' día(s)'})</td></tr>
        </table>
        <p style="color:#777;font-size:12px;margin-top:16px">Generado automáticamente por Agropower Console.</p>
    </div>`;
}

// Enviar aviso de aceite si corresponde (con deduplicación de 24h)
async function checkAndNotifyOil(row, table = 'tractores') {
    const info = computeOilInfo(row);
    if (!info.oilDue) return;

    const ultimo = asDate(row.aceite_notificado_at);
    const hace24h = new Date(Date.now() - 24 * 3600 * 1000);
    if (ultimo && ultimo > hace24h) return; // ya notificado en las últimas 24h

    const etiqueta = table === 'tractores' ? 'Tractor' : 'Equipo';
    const ok = await sendNotificationEmail(
        `[ALERTA] Cambio de aceite — ${row.marca} ${row.modelo} (${row.vin || row.serie || '—'})`,
        oilEmailHtml(row, info, etiqueta)
    );
    if (ok) {
        await pool.query(`UPDATE ${table} SET aceite_notificado_at = NOW() WHERE id = $1`, [row.id]);
    }
}

// Enviar aviso de cuota si corresponde (con deduplicación de 24h)
async function checkAndNotifyCuota(row, table = 'tractores') {
    const fin = computeFinancingInfo(row);
    if (!fin.financing || (!fin.vencida && !fin.proxima)) return;

    const ultimo = asDate(row.financiamiento_notificado_at);
    const hace24h = new Date(Date.now() - 24 * 3600 * 1000);
    if (ultimo && ultimo > hace24h) return;

    const etiqueta = table === 'tractores' ? 'Tractor' : 'Equipo';
    const ok = await sendNotificationEmail(
        `[FINANCIAMIENTO] Cuota ${fin.nextNumero}/${fin.total} — ${row.marca} ${row.modelo}`,
        cuotaEmailHtml(row, fin, etiqueta)
    );
    if (ok) {
        await pool.query(`UPDATE ${table} SET financiamiento_notificado_at = NOW() WHERE id = $1`, [row.id]);
    }
}

// 1. Configuración del Pool de Conexiones a PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:29879071@localhost:5432/agropower',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
// Función para auto-crear las tablas e insertar datos iniciales si no existen
async function initDB() {
    const tables = [
        {
            name: 'tractores',
            createQuery: `
                CREATE TABLE IF NOT EXISTS tractores (
                    id SERIAL PRIMARY KEY,
                    marca VARCHAR(100) DEFAULT 'Agropower',
                    modelo VARCHAR(100) NOT NULL,
                    hp INT NOT NULL,
                    cabina BOOLEAN DEFAULT false,
                    horas INT DEFAULT 0,
                    anio INT NOT NULL,
                    precio DECIMAL(12, 2) NOT NULL,
                    vin VARCHAR(100) UNIQUE NOT NULL,
                    estado VARCHAR(50) DEFAULT 'DISPONIBLE',
                    tipo_transmision VARCHAR(100) DEFAULT 'PowerShift 16x16',
                    traccion VARCHAR(50) DEFAULT '4WD',
                    fecha_entrega DATE,
                    aceite_ajuste INT DEFAULT 0,
                    aceite_pausado BOOLEAN DEFAULT false,
                    aceite_pausa_desde TIMESTAMP,
                    aceite_pausa_dias INT DEFAULT 0,
                    aceite_ultimo_cambio_at TIMESTAMP,
                    aceite_notificado_at TIMESTAMP,
                    tipo_venta VARCHAR(20) DEFAULT 'CONTADO',
                    fecha_inicio_financiamiento DATE,
                    cuotas_total INT DEFAULT 6,
                    cuotas_pagadas INT DEFAULT 0,
                    cuotas_pagos JSONB DEFAULT '[]'::jsonb,
                    monto_cuota DECIMAL(12, 2),
                    financiamiento_notificado_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `,
            migrationQuery: `
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS cuotas_pagos JSONB DEFAULT '[]'::jsonb;
                UPDATE tractores SET cuotas_pagos = COALESCE((SELECT jsonb_agg(jsonb_build_object('n', gs.n, 'fecha', NULL)) FROM generate_series(1, cuotas_pagadas) AS gs(n)), '[]'::jsonb) WHERE cuotas_pagadas > 0 AND (cuotas_pagos IS NULL OR jsonb_array_length(cuotas_pagos) = 0);
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS fecha_entrega DATE;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS aceite_ajuste INT DEFAULT 0;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS aceite_pausado BOOLEAN DEFAULT false;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS aceite_pausa_desde TIMESTAMP;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS aceite_pausa_dias INT DEFAULT 0;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS aceite_ultimo_cambio_at TIMESTAMP;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS aceite_notificado_at TIMESTAMP;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS tipo_venta VARCHAR(20) DEFAULT 'CONTADO';
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS fecha_inicio_financiamiento DATE;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS cuotas_total INT DEFAULT 6;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS cuotas_pagadas INT DEFAULT 0;
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS monto_cuota DECIMAL(12, 2);
                ALTER TABLE tractores ADD COLUMN IF NOT EXISTS financiamiento_notificado_at TIMESTAMP;
            `,
            seedQuery: `
                INSERT INTO tractores (marca, modelo, hp, cabina, horas, anio, precio, vin, estado, tipo_transmision, traccion, fecha_entrega)
                VALUES 
                ('Agropower', 'AG-130 Cabina', 130, true, 10, 2024, 68500, 'AGP-130C-2024-01', 'DISPONIBLE', 'PowerShift 16x16', '4WD', NULL),
                ('Agropower', 'AG-130 Cabina', 130, true, 45, 2024, 68500, 'AGP-130C-2024-02', 'DISPONIBLE', 'PowerShift 16x16', '4WD', NULL),
                ('Agropower', 'AG-130 Cabina', 130, true, 120, 2023, 65000, 'AGP-130C-2023-03', 'RESERVADO', 'PowerShift 16x16', '4WD', NULL),
                ('Agropower', 'AG-90 AgroSync', 90, false, 0, 2024, 42000, 'AGP-090S-2024-01', 'DISPONIBLE', 'Mecánica 12x12', '4WD', NULL),
                ('Agropower', 'AG-50 Compact', 50, false, 5, 2024, 26500, 'AGP-050C-2024-01', 'DISPONIBLE', 'Mecánica 8x8', '4WD', NULL);
            `
        },
        {
            name: 'repuestos',
            createQuery: `
                CREATE TABLE IF NOT EXISTS repuestos (
                    id SERIAL PRIMARY KEY,
                    codigo VARCHAR(50) UNIQUE NOT NULL,
                    nombre TEXT NOT NULL,
                    categoria VARCHAR(100) NOT NULL,
                    ubicacion VARCHAR(100) NOT NULL,
                    stock INT NOT NULL DEFAULT 0,
                    stock_minimo INT NOT NULL DEFAULT 5,
                    precio DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `,
            seedQuery: `
                INSERT INTO repuestos (codigo, nombre, categoria, ubicacion, stock, stock_minimo, precio)
                VALUES 
                ('RP-001', 'Filtro de aire', 'Mecánica', 'Almacén A', 10, 5, 25.00),
                ('RP-002', 'Aceite de motor', 'Mecánica', 'Almacén A', 20, 10, 15.00),
                ('RP-003', 'Pastillas de freno', 'Mecánica', 'Almacén B', 5, 5, 50.00),
                ('RP-004', 'Batería de arranque', 'Eléctrica', 'Almacén B', 8, 5, 100.00),
                ('RP-005', 'Lámparas delanteras', 'Eléctrica', 'Almacén C', 15, 10, 30.00);
            `
        },
        {
            name: 'despachos',
            createQuery: `
                CREATE TABLE IF NOT EXISTS despachos (
                    id SERIAL PRIMARY KEY,
                    num_guia VARCHAR(100) UNIQUE NOT NULL,
                    fecha DATE NOT NULL,
                    cliente TEXT NOT NULL,
                    destino TEXT NOT NULL,
                    maquinaria TEXT NOT NULL,
                    transportista TEXT NOT NULL,
                    total_usd DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
                    estado VARCHAR(50) DEFAULT 'EN TRÁNSITO',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `,
            seedQuery: `
                INSERT INTO despachos (num_guia, fecha, cliente, destino, maquinaria, transportista, total_usd, estado)
                VALUES 
                ('AGP-2026-101', '2026-07-18', 'Agropecuaria Valle Verde C.A.', 'Finca La Esperanza, Calabozo', 'Agropower AG-130 Cabina (130 HP)', 'Transportes Pesados del Llano', 68500.00, 'ENTREGADO'),
                ('AGP-2026-102', '2026-07-20', 'Consorcio Agrícola Guanare', 'Sector Portuguesa Central', 'Agropower AG-90 AgroSync (90 HP)', 'Servicios Logísticos Agro', 42000.00, 'ENTREGADO'),
                ('AGP-2026-103', '2026-07-21', 'Hacienda San Miguel', 'Predio Barinas Sur', 'Agropower AG-50 Compact (50 HP)', 'Fletes y Grúas Central', 26500.00, 'EN TRÁNSITO');
            `
        },
        {
            name: 'equipos',
            createQuery: `
                CREATE TABLE IF NOT EXISTS equipos (
                    id SERIAL PRIMARY KEY,
                    marca VARCHAR(100) DEFAULT 'Agropower',
                    modelo VARCHAR(100) NOT NULL,
                    tipo VARCHAR(100) DEFAULT 'Montacarga',
                    horas INT DEFAULT 0,
                    anio INT NOT NULL,
                    precio DECIMAL(12, 2) NOT NULL,
                    serie VARCHAR(100) UNIQUE NOT NULL,
                    estado VARCHAR(50) DEFAULT 'DISPONIBLE',
                    fecha_entrega DATE,
                    aceite_ajuste INT DEFAULT 0,
                    aceite_pausado BOOLEAN DEFAULT false,
                    aceite_pausa_desde TIMESTAMP,
                    aceite_pausa_dias INT DEFAULT 0,
                    aceite_ultimo_cambio_at TIMESTAMP,
                    aceite_notificado_at TIMESTAMP,
                    tipo_venta VARCHAR(20) DEFAULT 'CONTADO',
                    fecha_inicio_financiamiento DATE,
                    cuotas_total INT DEFAULT 6,
                    cuotas_pagadas INT DEFAULT 0,
                    cuotas_pagos JSONB DEFAULT '[]'::jsonb,
                    monto_cuota DECIMAL(12, 2),
                    financiamiento_notificado_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `,
            migrationQuery: `
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS cuotas_pagos JSONB DEFAULT '[]'::jsonb;
                UPDATE equipos SET cuotas_pagos = COALESCE((SELECT jsonb_agg(jsonb_build_object('n', gs.n, 'fecha', NULL)) FROM generate_series(1, cuotas_pagadas) AS gs(n)), '[]'::jsonb) WHERE cuotas_pagadas > 0 AND (cuotas_pagos IS NULL OR jsonb_array_length(cuotas_pagos) = 0);
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS fecha_entrega DATE;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS aceite_ajuste INT DEFAULT 0;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS aceite_pausado BOOLEAN DEFAULT false;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS aceite_pausa_desde TIMESTAMP;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS aceite_pausa_dias INT DEFAULT 0;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS aceite_ultimo_cambio_at TIMESTAMP;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS aceite_notificado_at TIMESTAMP;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS tipo_venta VARCHAR(20) DEFAULT 'CONTADO';
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS fecha_inicio_financiamiento DATE;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS cuotas_total INT DEFAULT 6;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS cuotas_pagadas INT DEFAULT 0;
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS monto_cuota DECIMAL(12, 2);
                ALTER TABLE equipos ADD COLUMN IF NOT EXISTS financiamiento_notificado_at TIMESTAMP;
            `,
            seedQuery: `
                INSERT INTO equipos (marca, modelo, tipo, horas, anio, precio, serie, estado, fecha_entrega)
                VALUES 
                ('Toyota', 'FG25 Montacargas 2.5t', 'Montacarga', 300, 2023, 18500, 'EQP-MONT-001', 'DISPONIBLE', NULL),
                ('Crown', 'SC 4500 Transpaleta', 'Transpaleta', 120, 2024, 8200, 'EQP-TRAN-001', 'DISPONIBLE', NULL);
            `
        }
    ];

    try {
        for (const table of tables) {
            await pool.query(table.createQuery);
            if (table.migrationQuery) {
                await pool.query(table.migrationQuery);
            }
            console.log(`✅ Tabla "${table.name}" verificada/creada exitosamente en PostgreSQL.`);

            const countRes = await pool.query(`SELECT COUNT(*) FROM ${table.name}`);
            if (parseInt(countRes.rows[0].count, 10) === 0) {
                console.log(`🌱 Poblando tabla "${table.name}" con datos iniciales...`);
                await pool.query(table.seedQuery);
                console.log(`✅ Registros iniciales cargados para "${table.name}".`);
            }
        }
    } catch (err) {
        console.error('❌ Error al inicializar la base de datos:', err.message);
    }
}

// Probar conexión e inicializar BD
pool.connect(async (err, client, release) => {
    if (err) {
        console.error('❌ Error al conectar a PostgreSQL:', err.message);
        if (err.code === '3D000') {
            console.error('💡 La base de datos "agropower_db" no existe. Por favor créala con: CREATE DATABASE agropower_db;');
        } else if (err.code === '28P01') {
            console.error('💡 Contraseña de PostgreSQL incorrecta en la cadena de conexión.');
        } else if (err.code === 'ECONNREFUSED') {
            console.error('💡 El servicio de PostgreSQL no está ejecutándose en localhost:5432.');
        }
    } else {
        console.log('✅ Conexión exitosa a PostgreSQL');
        release();
        await initDB();
    }
});

// 2. Middlewares Globales y Configuración de CORS
app.use(express.json());
app.use(cors({
    origin: '*',
    allowedHeaders: ['Content-Type', 'x-admin-key'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// Simple request logger for debugging
app.use((req, res, next) => {
    console.log('[REQ]', req.method, req.path, 'x-admin-key=', req.headers['x-admin-key']);
    next();
});

// 3. Middleware de Autenticación
function authenticateAdmin(req, res, next) {
    const clientKey = req.headers['x-admin-key'];
    console.log('authenticateAdmin header x-admin-key =', clientKey);
    if (!clientKey || clientKey !== ADMIN_SECRET_KEY) {
        return res.status(401).json({ error: 'Acceso no autorizado. Clave de administración (x-admin-key) inválida o ausente.' });
    }
    next();
}

// 4. Endpoints CRUD para PostgreSQL (/api/tractores)

// GET: Consultar todos los tractores
app.get('/api/tractores', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM tractores ORDER BY id DESC');
        const rows = result.rows.map(r => enrichRow({ ...r, cabina: r.cabina === true || r.cabina === 'true' || r.cabina === '1' }));
        res.json(rows);

        // Notificaciones por correo en segundo plano (no bloquea la respuesta)
        rows.forEach(t => {
            checkAndNotifyOil(t, 'tractores').catch(err => console.error('Error notif. aceite:', err.message));
            checkAndNotifyCuota(t, 'tractores').catch(err => console.error('Error notif. cuota:', err.message));
        });
    } catch (err) {
        console.error('Error SELECT:', err);
        res.status(500).json({ error: 'Error al consultar la base de datos PostgreSQL' });
    }
});

// POST: Crear un nuevo tractor
app.post('/api/tractores', authenticateAdmin, async (req, res) => {
    const { marca, modelo, hp, cabina, horas, anio, precio, vin, estado, tipoTransmision, traccion, fechaEntrega, tipoVenta, fechaInicioFinanciamiento, cuotasTotal, cuotasPagadas, cuotasPagos, montoCuota } = req.body;
    const cabinaNormalized = cabina === true || cabina === 'true' || cabina === '1';
    const pagos = Array.isArray(cuotasPagos) ? cuotasPagos.filter(p => p && p.n).map(p => ({ n: Number(p.n), fecha: p.fecha || null })) : null;
    const cuotasPagadasFinal = pagos ? pagos.length : (parseInt(cuotasPagadas, 10) || 0);

    try {
        const result = await pool.query(
            `INSERT INTO tractores (marca, modelo, hp, cabina, horas, anio, precio, vin, estado, tipo_transmision, traccion, fecha_entrega, tipo_venta, fecha_inicio_financiamiento, cuotas_total, cuotas_pagadas, cuotas_pagos, monto_cuota) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) 
             RETURNING *`,
            [
                marca || 'Agropower', 
                modelo, 
                hp, 
                cabinaNormalized, 
                horas || 0, 
                anio, 
                precio, 
                vin, 
                estado || 'DISPONIBLE', 
                tipoTransmision || 'PowerShift 16x16', 
                traccion || '4WD',
                fechaEntrega || null,
                tipoVenta || 'CONTADO',
                fechaInicioFinanciamiento || null,
                cuotasTotal || 6,
                cuotasPagadasFinal,
                pagos ? JSON.stringify(pagos) : null,
                montoCuota || null
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error INSERT:', err);
        res.status(500).json({ error: 'Error al insertar en PostgreSQL' });
    }
});

// PUT: Actualizar un tractor existente por ID
app.put('/api/tractores/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { marca, modelo, hp, cabina, horas, anio, precio, vin, estado, tipoTransmision, traccion, fechaEntrega, tipoVenta, fechaInicioFinanciamiento, cuotasTotal, cuotasPagadas, cuotasPagos, montoCuota } = req.body;
    const cabinaBool = cabina === true || cabina === 'true' || cabina === '1';
    const pagos = Array.isArray(cuotasPagos) ? cuotasPagos.filter(p => p && p.n).map(p => ({ n: Number(p.n), fecha: p.fecha || null })) : null;
    const cuotasPagadasFinal = pagos ? pagos.length : (parseInt(cuotasPagadas, 10) || 0);

    console.log('[PUT] /api/tractores/:id -> id=', id, 'body=', req.body);

    try {
        const result = await pool.query(
            `UPDATE tractores 
             SET marca = $1, modelo = $2, hp = $3, cabina = $4, horas = $5, anio = $6, precio = $7, vin = $8, estado = $9, tipo_transmision = $10, traccion = $11,
                 fecha_entrega = $12, tipo_venta = $13, fecha_inicio_financiamiento = $14, cuotas_total = $15, cuotas_pagadas = $16, cuotas_pagos = $17, monto_cuota = $18
             WHERE id = $19 
             RETURNING *`,
            [marca || 'Agropower', modelo, hp, cabinaBool, horas, anio, precio, vin, estado, tipoTransmision, traccion, fechaEntrega || null, tipoVenta || 'CONTADO', fechaInicioFinanciamiento || null, cuotasTotal || 6, cuotasPagadasFinal, pagos ? JSON.stringify(pagos) : null, montoCuota || null, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Tractor no encontrado.' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error UPDATE tractores:', err && err.stack ? err.stack : err);
        res.status(500).json({ error: 'Error al actualizar el registro en la base de datos PostgreSQL', detail: err.message || String(err) });
    }
});

// POST: Pausar el contador de aceite (mantenimiento)
app.post('/api/tractores/:id/aceite/pausar', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `UPDATE tractores 
             SET aceite_pausado = true, aceite_pausa_desde = NOW()
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Tractor no encontrado.' });
        res.json({ message: 'Contador de aceite pausado.', tractor: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error pausar aceite:', err);
        res.status(500).json({ error: 'Error al pausar el contador de aceite.' });
    }
});

// POST: Reanudar el contador de aceite (fin de mantenimiento)
app.post('/api/tractores/:id/aceite/reanudar', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const prev = await pool.query('SELECT * FROM tractores WHERE id = $1', [id]);
        if (prev.rowCount === 0) return res.status(404).json({ error: 'Tractor no encontrado.' });
        const t = prev.rows[0];

        let dias = parseInt(t.aceite_pausa_dias || 0, 10) || 0;
        if (t.aceite_pausa_desde) {
            dias += Math.max(0, daysBetween(asDate(t.aceite_pausa_desde), new Date()));
        }

        const result = await pool.query(
            `UPDATE tractores 
             SET aceite_pausado = false, aceite_pausa_desde = NULL, aceite_pausa_dias = $1
             WHERE id = $2
             RETURNING *`,
            [dias, id]
        );
        res.json({ message: 'Contador de aceite reanudado.', tractor: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error reanudar aceite:', err);
        res.status(500).json({ error: 'Error al reanudar el contador de aceite.' });
    }
});

// POST: Establecer manualmente las horas del contador de aceite (valor absoluto)
app.post('/api/tractores/:id/aceite/ajustar', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { horasAceite } = req.body;
    const objetivo = parseInt(horasAceite, 10);
    if (isNaN(objetivo) || objetivo < 0) {
        return res.status(400).json({ error: 'horasAceite debe ser un número mayor o igual a 0.' });
    }

    try {
        const prev = await pool.query('SELECT * FROM tractores WHERE id = $1', [id]);
        if (prev.rowCount === 0) return res.status(404).json({ error: 'Tractor no encontrado.' });
        const info = computeOilInfo(prev.rows[0]);
        // Horas que provienen solo del conteo diario (10 h/día), sin ajuste manual previo
        const base = Math.max(0, info.oilHours - (info.oilAdjusted || 0));
        const nuevoAjuste = objetivo - base;

        const result = await pool.query(
            `UPDATE tractores 
             SET aceite_ajuste = $1
             WHERE id = $2
             RETURNING *`,
            [nuevoAjuste, id]
        );
        res.json({ message: 'Horas del contador establecidas.', tractor: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error ajustar aceite:', err);
        res.status(500).json({ error: 'Error al ajustar el contador de aceite.' });
    }
});

// POST: Registrar un cambio de aceite (reinicia el contador)
app.post('/api/tractores/:id/aceite/cambio', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `UPDATE tractores 
             SET aceite_ultimo_cambio_at = NOW(), aceite_ajuste = 0, aceite_pausado = false, aceite_pausa_desde = NULL, aceite_pausa_dias = 0, aceite_notificado_at = NULL
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Tractor no encontrado.' });
        res.json({ message: 'Cambio de aceite registrado. Contador reiniciado.', tractor: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error cambio de aceite:', err);
        res.status(500).json({ error: 'Error al registrar el cambio de aceite.' });
    }
});

// POST: Registrar una cuota como pagada
app.post('/api/tractores/:id/cuota/pagar', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const prev = await pool.query('SELECT * FROM tractores WHERE id = $1', [id]);
        if (prev.rowCount === 0) return res.status(404).json({ error: 'Tractor no encontrado.' });
        const t = prev.rows[0];
        const total = parseInt(t.cuotas_total || TOTAL_CUOTAS, 10) || TOTAL_CUOTAS;
        let pagos = Array.isArray(t.cuotas_pagos) ? t.cuotas_pagos.map(p => ({ n: Number(p.n), fecha: p.fecha || null })) : [];
        const pagadas = Math.max(pagos.length, parseInt(t.cuotas_pagadas || 0, 10) || 0);

        if (pagadas >= total) {
            return res.status(400).json({ error: 'El financiamiento ya está saldado.' });
        }

        while (pagos.length < pagadas) pagos.push({ n: pagos.length + 1, fecha: null });
        pagos.push({ n: pagadas + 1, fecha: new Date().toISOString().split('T')[0] });

        const result = await pool.query(
            `UPDATE tractores 
             SET cuotas_pagadas = $1, cuotas_pagos = $2, financiamiento_notificado_at = NULL
             WHERE id = $3
             RETURNING *`,
            [pagos.length, JSON.stringify(pagos), id]
        );
        res.json({ message: `Cuota ${pagadas + 1}/${total} registrada como pagada.`, tractor: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error pagar cuota:', err);
        res.status(500).json({ error: 'Error al registrar el pago de la cuota.' });
    }
});

// POST: Pausar el contador de aceite de un equipo
app.post('/api/equipos/:id/aceite/pausar', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `UPDATE equipos 
             SET aceite_pausado = true, aceite_pausa_desde = NOW()
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Equipo no encontrado.' });
        res.json({ message: 'Contador de aceite pausado.', equipo: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error pausar aceite equipo:', err);
        res.status(500).json({ error: 'Error al pausar el contador de aceite.' });
    }
});

// POST: Reanudar el contador de aceite de un equipo
app.post('/api/equipos/:id/aceite/reanudar', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const prev = await pool.query('SELECT * FROM equipos WHERE id = $1', [id]);
        if (prev.rowCount === 0) return res.status(404).json({ error: 'Equipo no encontrado.' });
        const t = prev.rows[0];

        let dias = parseInt(t.aceite_pausa_dias || 0, 10) || 0;
        if (t.aceite_pausa_desde) {
            dias += Math.max(0, daysBetween(asDate(t.aceite_pausa_desde), new Date()));
        }

        const result = await pool.query(
            `UPDATE equipos 
             SET aceite_pausado = false, aceite_pausa_desde = NULL, aceite_pausa_dias = $1
             WHERE id = $2
             RETURNING *`,
            [dias, id]
        );
        res.json({ message: 'Contador de aceite reanudado.', equipo: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error reanudar aceite equipo:', err);
        res.status(500).json({ error: 'Error al reanudar el contador de aceite.' });
    }
});

// POST: Establecer manualmente las horas del contador de aceite de un equipo
app.post('/api/equipos/:id/aceite/ajustar', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { horasAceite } = req.body;
    const objetivo = parseInt(horasAceite, 10);
    if (isNaN(objetivo) || objetivo < 0) {
        return res.status(400).json({ error: 'horasAceite debe ser un número mayor o igual a 0.' });
    }

    try {
        const prev = await pool.query('SELECT * FROM equipos WHERE id = $1', [id]);
        if (prev.rowCount === 0) return res.status(404).json({ error: 'Equipo no encontrado.' });
        const info = computeOilInfo(prev.rows[0]);
        const base = Math.max(0, info.oilHours - (info.oilAdjusted || 0));
        const nuevoAjuste = objetivo - base;

        const result = await pool.query(
            `UPDATE equipos 
             SET aceite_ajuste = $1
             WHERE id = $2
             RETURNING *`,
            [nuevoAjuste, id]
        );
        res.json({ message: 'Horas del contador establecidas.', equipo: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error ajustar aceite equipo:', err);
        res.status(500).json({ error: 'Error al ajustar el contador de aceite.' });
    }
});

// POST: Registrar un cambio de aceite en un equipo
app.post('/api/equipos/:id/aceite/cambio', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `UPDATE equipos 
             SET aceite_ultimo_cambio_at = NOW(), aceite_ajuste = 0, aceite_pausado = false, aceite_pausa_desde = NULL, aceite_pausa_dias = 0, aceite_notificado_at = NULL
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Equipo no encontrado.' });
        res.json({ message: 'Cambio de aceite registrado. Contador reiniciado.', equipo: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error cambio de aceite equipo:', err);
        res.status(500).json({ error: 'Error al registrar el cambio de aceite.' });
    }
});

// POST: Registrar una cuota de un equipo como pagada
app.post('/api/equipos/:id/cuota/pagar', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const prev = await pool.query('SELECT * FROM equipos WHERE id = $1', [id]);
        if (prev.rowCount === 0) return res.status(404).json({ error: 'Equipo no encontrado.' });
        const t = prev.rows[0];
        const total = parseInt(t.cuotas_total || TOTAL_CUOTAS, 10) || TOTAL_CUOTAS;
        let pagos = Array.isArray(t.cuotas_pagos) ? t.cuotas_pagos.map(p => ({ n: Number(p.n), fecha: p.fecha || null })) : [];
        const pagadas = Math.max(pagos.length, parseInt(t.cuotas_pagadas || 0, 10) || 0);

        if (pagadas >= total) {
            return res.status(400).json({ error: 'El financiamiento ya está saldado.' });
        }

        while (pagos.length < pagadas) pagos.push({ n: pagos.length + 1, fecha: null });
        pagos.push({ n: pagadas + 1, fecha: new Date().toISOString().split('T')[0] });

        const result = await pool.query(
            `UPDATE equipos 
             SET cuotas_pagadas = $1, cuotas_pagos = $2, financiamiento_notificado_at = NULL
             WHERE id = $3
             RETURNING *`,
            [pagos.length, JSON.stringify(pagos), id]
        );
        res.json({ message: `Cuota ${pagadas + 1}/${total} registrada como pagada.`, equipo: enrichRow(result.rows[0]) });
    } catch (err) {
        console.error('Error pagar cuota equipo:', err);
        res.status(500).json({ error: 'Error al registrar el pago de la cuota.' });
    }
});

// DELETE: Eliminar un tractor por ID
app.delete('/api/tractores/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM tractores WHERE id = $1 RETURNING *', [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Tractor no encontrado para eliminar.' });
        }

        res.json({ message: 'Tractor eliminado correctamente', deleted: result.rows[0] });
    } catch (err) {
        console.error('Error DELETE:', err);
        res.status(500).json({ error: 'Error al eliminar el registro en PostgreSQL' });
    }
});
// 5. Endpoints CRUD para PostgreSQL (/api/equipos)
app.get('/api/equipos', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM equipos ORDER BY id DESC');
        res.json(result.rows.map(enrichRow));

        result.rows.forEach(e => {
            checkAndNotifyOil(e, 'equipos').catch(err => console.error('Error notif. aceite equipo:', err.message));
            checkAndNotifyCuota(e, 'equipos').catch(err => console.error('Error notif. cuota equipo:', err.message));
        });
    } catch (err) {
        console.error('Error SELECT equipos:', err);
        res.status(500).json({ error: 'Error al consultar equipos en PostgreSQL' });
    }
});

app.post('/api/equipos', authenticateAdmin, async (req, res) => {
    const { marca, modelo, tipo, horas, anio, precio, serie, estado, fechaEntrega, tipoVenta, fechaInicioFinanciamiento, cuotasTotal, cuotasPagadas, cuotasPagos, montoCuota } = req.body;
    const pagos = Array.isArray(cuotasPagos) ? cuotasPagos.filter(p => p && p.n).map(p => ({ n: Number(p.n), fecha: p.fecha || null })) : null;
    const cuotasPagadasFinal = pagos ? pagos.length : (parseInt(cuotasPagadas, 10) || 0);

    try {
        const result = await pool.query(
            `INSERT INTO equipos (marca, modelo, tipo, horas, anio, precio, serie, estado, fecha_entrega, tipo_venta, fecha_inicio_financiamiento, cuotas_total, cuotas_pagadas, cuotas_pagos, monto_cuota) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) 
             RETURNING *`,
            [
                marca || 'Agropower',
                modelo,
                tipo || 'Montacarga',
                horas || 0,
                anio,
                precio,
                serie,
                estado || 'DISPONIBLE',
                fechaEntrega || null,
                tipoVenta || 'CONTADO',
                fechaInicioFinanciamiento || null,
                cuotasTotal || 6,
                cuotasPagadasFinal,
                pagos ? JSON.stringify(pagos) : null,
                montoCuota || null
            ]
        );
        res.status(201).json(enrichRow(result.rows[0]));
    } catch (err) {
        console.error('Error INSERT equipos:', err);
        res.status(500).json({ error: 'Error al insertar equipo en PostgreSQL' });
    }
});

app.put('/api/equipos/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { marca, modelo, tipo, horas, anio, precio, serie, estado, fechaEntrega, tipoVenta, fechaInicioFinanciamiento, cuotasTotal, cuotasPagadas, cuotasPagos, montoCuota } = req.body;
    const pagos = Array.isArray(cuotasPagos) ? cuotasPagos.filter(p => p && p.n).map(p => ({ n: Number(p.n), fecha: p.fecha || null })) : null;
    const cuotasPagadasFinal = pagos ? pagos.length : (parseInt(cuotasPagadas, 10) || 0);

    console.log('[PUT] /api/equipos/:id -> id=', id, 'body=', req.body);

    try {
        const result = await pool.query(
            `UPDATE equipos 
             SET marca = $1, modelo = $2, tipo = $3, horas = $4, anio = $5, precio = $6, serie = $7, estado = $8,
                 fecha_entrega = $9, tipo_venta = $10, fecha_inicio_financiamiento = $11, cuotas_total = $12, cuotas_pagadas = $13, cuotas_pagos = $14, monto_cuota = $15
             WHERE id = $16 
             RETURNING *`,
            [marca || 'Agropower', modelo, tipo || 'Montacarga', horas, anio, precio, serie, estado, fechaEntrega || null, tipoVenta || 'CONTADO', fechaInicioFinanciamiento || null, cuotasTotal || 6, cuotasPagadasFinal, pagos ? JSON.stringify(pagos) : null, montoCuota || null, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Equipo no encontrado.' });
        }

        res.json(enrichRow(result.rows[0]));
    } catch (err) {
        console.error('Error UPDATE equipos:', err && err.stack ? err.stack : err);
        res.status(500).json({ error: 'Error al actualizar el equipo en PostgreSQL', detail: err.message || String(err) });
    }
});

app.delete('/api/equipos/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM equipos WHERE id = $1 RETURNING *', [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Equipo no encontrado para eliminar.' });
        }

        res.json({ message: 'Equipo eliminado correctamente', deleted: result.rows[0] });
    } catch (err) {
        console.error('Error DELETE equipos:', err);
        res.status(500).json({ error: 'Error al eliminar el equipo en PostgreSQL' });
    }
});

// 6. Endpoints CRUD para PostgreSQL (/api/despachos)
app.get('/api/despachos', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM despachos ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error SELECT despachos:', err);
        res.status(500).json({ error: 'Error al consultar despachos en PostgreSQL' });
    }
});

app.post('/api/despachos', authenticateAdmin, async (req, res) => {
    const { numGuia, fecha, cliente, destino, maquinaria, transportista, totalUSD, estado } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO despachos (num_guia, fecha, cliente, destino, maquinaria, transportista, total_usd, estado)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [numGuia, fecha, cliente, destino, maquinaria, transportista, totalUSD || 0, estado || 'EN TRÁNSITO']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error INSERT despachos:', err);
        res.status(500).json({ error: 'Error al insertar despacho en PostgreSQL' });
    }
});

app.put('/api/despachos/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { numGuia, fecha, cliente, destino, maquinaria, transportista, totalUSD, estado } = req.body;

    try {
        const result = await pool.query(
            `UPDATE despachos
             SET num_guia = $1, fecha = $2, cliente = $3, destino = $4, maquinaria = $5, transportista = $6, total_usd = $7, estado = $8
             WHERE id = $9
             RETURNING *`,
            [numGuia, fecha, cliente, destino, maquinaria, transportista, totalUSD || 0, estado || 'EN TRÁNSITO', id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Despacho no encontrado.' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error UPDATE despachos:', err);
        res.status(500).json({ error: 'Error al actualizar el despacho en PostgreSQL' });
    }
});

app.delete('/api/despachos/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM despachos WHERE id = $1 RETURNING *', [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Despacho no encontrado para eliminar.' });
        }

        res.json({ message: 'Despacho eliminado correctamente', deleted: result.rows[0] });
    } catch (err) {
        console.error('Error DELETE despachos:', err);
        res.status(500).json({ error: 'Error al eliminar el despacho en PostgreSQL' });
    }
});

// 6. Endpoints CRUD para PostgreSQL (/api/repuestos)
app.get('/api/repuestos', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM repuestos ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error SELECT repuestos:', err);
        res.status(500).json({ error: 'Error al consultar repuestos en PostgreSQL' });
    }
});

app.post('/api/repuestos', authenticateAdmin, async (req, res) => {
    const { codigo, nombre, categoria, ubicacion, stock, stockMinimo, precio } = req.body;

    try {
        const result = await pool.query(
            `INSERT INTO repuestos (codigo, nombre, categoria, ubicacion, stock, stock_minimo, precio)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [codigo, nombre, categoria, ubicacion, stock || 0, stockMinimo || 5, precio || 0]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error INSERT repuestos:', err);
        res.status(500).json({ error: 'Error al insertar repuesto en PostgreSQL' });
    }
});

app.put('/api/repuestos/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    const { codigo, nombre, categoria, ubicacion, stock, stockMinimo, precio } = req.body;

    console.log('[PUT] /api/repuestos/:id -> id=', id, 'body=', req.body);

    try {
        const result = await pool.query(
            `UPDATE repuestos
             SET codigo = $1, nombre = $2, categoria = $3, ubicacion = $4, stock = $5, stock_minimo = $6, precio = $7
             WHERE id = $8
             RETURNING *`,
            [codigo, nombre, categoria, ubicacion, stock || 0, stockMinimo || 5, precio || 0, id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Repuesto no encontrado.' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error UPDATE repuestos:', err && err.stack ? err.stack : err);
        res.status(500).json({ error: 'Error al actualizar el repuesto en PostgreSQL', detail: err.message || String(err) });
    }
});

app.delete('/api/repuestos/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM repuestos WHERE id = $1 RETURNING *', [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Repuesto no encontrado para eliminar.' });
        }

        res.json({ message: 'Repuesto eliminado correctamente', deleted: result.rows[0] });
    } catch (err) {
        console.error('Error DELETE repuestos:', err);
        res.status(500).json({ error: 'Error al eliminar el repuesto en PostgreSQL' });
    }
});

// Servir archivos estáticos del frontend (index.html, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint de depuración para listar rutas registradas
app.get('/__routes', (req, res) => {
    const routes = app._router && app._router.stack ? app._router.stack.filter(l => l.route).map(l => Object.keys(l.route.methods).join(',').toUpperCase() + ' ' + l.route.path) : [];
    res.json({ routes });
});

// Fallback para SPA / Frontend (sirve index.html para rutas cliente, pero
// devuelve JSON 404 para rutas API no encontradas para evitar que el cliente
// intente parsear HTML como JSON).
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API route not found' });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar Servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor Agropower ejecutándose en http://localhost:${PORT}`);
});

// Escaneo periódico de notificaciones (cada hora)
async function runNotificationScan() {
    try {
        for (const table of ['tractores', 'equipos']) {
            const result = await pool.query(`SELECT * FROM ${table}`);
            for (const row of result.rows) {
                await checkAndNotifyOil(row, table).catch(err => console.error(`Error notif. aceite ${table}:`, err.message));
                await checkAndNotifyCuota(row, table).catch(err => console.error(`Error notif. cuota ${table}:`, err.message));
            }
        }
    } catch (err) {
        console.error('❌ Error en escaneo periódico de notificaciones:', err.message);
    }
}
setInterval(runNotificationScan, 60 * 60 * 1000);