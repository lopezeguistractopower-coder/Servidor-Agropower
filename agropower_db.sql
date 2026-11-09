DROP TABLE IF EXISTS despachos;
DROP TABLE IF EXISTS repuestos;
DROP TABLE IF EXISTS equipos;
DROP TABLE IF EXISTS tractores;
DROP TABLE IF EXISTS instrumentosagricolas;

CREATE TABLE tractores (
    id SERIAL PRIMARY KEY,
    marca VARCHAR(100) DEFAULT 'Agropower',
    modelo VARCHAR(100) NOT NULL,
    hp INT NOT NULL,
    cabina BOOLEAN DEFAULT false,
    horas INT DEFAULT 0,
    anio INT NOT NULL,
    precio DECIMAL(12,2) NOT NULL,
    vin VARCHAR(100) UNIQUE NOT NULL,
    estado VARCHAR(50) DEFAULT 'DISPONIBLE',
    tipo_transmision VARCHAR(100),
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
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repuestos (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(50) UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    categoria VARCHAR(100) NOT NULL,
    ubicacion VARCHAR(100) NOT NULL,
    stock INT NOT NULL DEFAULT 0,
    stock_minimo INT NOT NULL DEFAULT 5,
    precio DECIMAL(10, 2) NOT NULL DEFAULT 0.00
);

CREATE TABLE despachos (
    id SERIAL PRIMARY KEY,
    num_guia VARCHAR(100) UNIQUE NOT NULL,
    fecha DATE DEFAULT CURRENT_DATE,
    cliente VARCHAR(255) NOT NULL,
    destino VARCHAR(255) NOT NULL,
    maquinaria VARCHAR(255) NOT NULL,
    transportista VARCHAR(255) NOT NULL,
    total_usd DECIMAL(12,2) NOT NULL,
    estado VARCHAR(50) DEFAULT 'EN TRÁNSITO'
);

CREATE TABLE equipos (
    id SERIAL PRIMARY KEY,
    marca VARCHAR(100) DEFAULT 'Agropower',
    modelo VARCHAR(100) NOT NULL,
    tipo VARCHAR(100) DEFAULT 'Montacarga',
    horas INT DEFAULT 0,
    anio INT NOT NULL,
    precio DECIMAL(12,2) NOT NULL,
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
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);