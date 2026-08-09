# GenX Viewer — Visor DICOM (OHIF + AWS HealthImaging)

Fork de [OHIF Viewer](https://github.com/OHIF/Viewers) configurado para conectarse a AWS HealthImaging. Renderiza imágenes DICOM en HTJ2K directamente en el browser, sin servidor de aplicaciones.

## Arquitectura

```
Browser (OHIF estático)
   │
   │  prod: TODO por el mismo dominio de CloudFront (same-origin)
   │
   ├── /vN/*   → S3 (sitio estático)      dev: localhost:3000
   │
   └── /api/*  → Lambda proxy → AWS HealthImaging
                                          dev: localhost:8089
```

El visor es un sitio estático (HTML/JS/CSS). El proxy es un servicio Node.js que firma requests con credenciales AWS y los reenvía a HealthImaging. Un solo proxy sirve a todos los hospitales — el `datastoreID` viene en cada request.

**En prod el proxy se sirve por CloudFront bajo `/api/*`, no por su Function URL.** Los Function URLs hablan HTTP/1.1, así que el navegador tenía las series capadas a 6 frames en vuelo, cada uno con round-trip propio a us-east-1; y al ser otro origen, se pagaba un preflight CORS encima. Por CloudFront hay multiplexado HTTP/2, el CORS desaparece y el salto edge→Lambda va por backbone de AWS. La Lambda recorta el prefijo `/api` (`PATH_PREFIX` en `proxy/lambda.js`) antes de reescribir la URL.

Los tres sitios que tienen que decir lo mismo si se cambia el prefijo:

| Qué | Dónde |
|---|---|
| Path pattern de CloudFront | `infra/modules/viewer-site` (`proxy_path_pattern`) |
| Strip en la Lambda | `proxy/lambda.js` (`PATH_PREFIX`) |
| `endpoint` / `wadoRoot` | `platform/app/public/config/aws-healthimaging-v2.js` |

Contexto completo (por qué el caché está apagado, por qué OAC no aplica): [`infra/viewer/README.md`](../infra/viewer/README.md).

**Versiones desplegadas:** `v1` apunta directo al Function URL (legacy, se conserva como rollback y línea base de comparación); `v2` en adelante usan `/api`. En dev no hay prefijo: el visor le pega a `localhost:8089` y `lambda.js` no interviene.

## Estructura del proyecto

```
viewer/
├── proxy/                          # Proxy de HealthImaging
│   ├── core.js                     # Lógica compartida (rewrite URLs + firma AWS)
│   ├── index.js                    # Entry point desarrollo (HTTP server → Docker)
│   ├── lambda.js                   # Entry point producción (AWS Lambda handler)
│   ├── Dockerfile                  # Build para Docker local
│   └── package.json
│
├── platform/app/
│   ├── public/config/
│   │   ├── genx-base.js            # Config compartida por todos los clientes
│   │   ├── clients/{slug}.js       # Delta por cliente (datastore, título, logo)
│   │   └── aws-healthimaging.js    # v1/v2: CONGELADOS, solo rollback
│   ├── public/assets/
│   │   ├── genx-logo.png           # Logo GenX (header del visor)
│   │   └── genx-icon.png           # Ícono GenX (favicon)
│   ├── public/html-templates/
│   │   └── index.html              # Título y favicon
│   └── pluginConfig.json           # Extensiones registradas (incluye healthimaging)
│
├── docker-compose.yml              # Levanta el proxy en desarrollo
├── .env.example                    # Template de credenciales AWS
└── .env                            # (gitignored) credenciales reales
```

## Desarrollo local

### Requisitos
- Node.js 18+
- Yarn (classic)
- Docker

### Setup inicial (una sola vez)

```bash
cd viewer

# Instalar dependencias
yarn set version classic
yarn install --frozen-lockfile

# Configurar credenciales para el proxy
cp .env.example .env
# Editar .env con tus AWS_ACCESS_KEY_ID y AWS_SECRET_ACCESS_KEY
```

### Levantar

```bash
# 1. Proxy (en background)
docker compose up -d

# 2. Visor (dev server con hot reload)
APP_CONFIG=config/aws-healthimaging.js yarn run dev
```

Abrir http://localhost:3000

### Verificar que funciona

- El proxy responde en http://localhost:8089
- El visor lista los estudios del datastore configurado
- Al hacer clic en un estudio, las imágenes cargan en el viewport

## Build de producción

```bash
APP_CONFIG=config/aws-healthimaging.js yarn run build
```

Output en `platform/app/dist/`. Son archivos estáticos listos para servir.

## Deploy a AWS

### Visor estático → S3 + CloudFront

```bash
# Subir build a S3
aws s3 sync platform/app/dist/ s3://genx-ohif-viewer/

# Invalidar cache de CloudFront
aws cloudfront create-invalidation \
  --distribution-id DISTRIBUTION_ID \
  --paths "/*"
```

Costo: ~$0/mes (free tier de CloudFront + S3).

### Proxy → Lambda Function URL

El proxy usa `proxy/lambda.js` como entry point en Lambda. No necesita API Gateway.

```bash
# Crear zip para Lambda
cd proxy
npm install --production
zip -r ../proxy-lambda.zip .
cd ..

# Crear función Lambda
aws lambda create-function \
  --function-name genx-healthimaging-proxy \
  --runtime nodejs20.x \
  --handler lambda.handler \
  --zip-file fileb://proxy-lambda.zip \
  --role arn:aws:iam::ACCOUNT:role/LambdaHealthImagingRole \
  --environment Variables="{AWS_REGION=us-east-1}" \
  --timeout 30 \
  --memory-size 256

# Crear Function URL (acceso público)
aws lambda create-function-url-config \
  --function-name genx-healthimaging-proxy \
  --auth-type NONE \
  --cors '{
    "AllowOrigins": ["*"],
    "AllowMethods": ["GET", "POST", "OPTIONS"],
    "AllowHeaders": ["*"]
  }'
```

El IAM role de Lambda necesita:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "medical-imaging:SearchImageSets",
        "medical-imaging:GetImageSet",
        "medical-imaging:GetImageSetMetadata",
        "medical-imaging:GetImageFrame",
        "medical-imaging:ListImageSetVersions"
      ],
      "Resource": "*"
    }
  ]
}
```

En Lambda no se pasan credenciales AWS como env vars — el execution role las provee automáticamente.

Costo: ~$0/mes (free tier de Lambda cubre el uso típico).

### Apuntar el visor al proxy de producción

Ruta **relativa**, no la URL del Function URL — así el request sale al mismo dominio que sirve el visor y CloudFront lo enruta al proxy (ver arquitectura arriba). Es lo que ya trae `aws-healthimaging-v2.js`:

```javascript
healthlake: {
  datastoreID: 'TU_DATASTORE_ID',
  endpoint: '/api',
},
wadoRoot: '/api',
```

`endpoint` **no puede ser `''`**: el extension lanza `endpoint is mandatory` con cualquier valor falsy al montar su override de XHR. Por eso hay prefijo y no raíz pelada.

## Cómo funciona el proxy

El proxy resuelve dos problemas:

1. **Credenciales**: El browser no puede tener credenciales AWS. El proxy firma los requests con `aws4` antes de reenviarlos.

2. **Reescritura de URLs**: OHIF genera URLs DICOMWeb estándar (`/studies/.../frames/1?...`), pero HealthImaging usa su propia API (`/datastore/{id}/imageSet/{id}/getImageFrame`). El proxy intercepta y reescribe automáticamente.

```
OHIF pide:  GET /studies/{uid}/series/{uid}/.../frames/1?DatastoreID=xxx&ImageSetID=yyy&frameID=zzz
Proxy hace: POST /datastore/xxx/imageSet/yyy/getImageFrame  { imageFrameId: "zzz" }
```

## Multi-cliente

**Se compila una vez y se publica N veces.** Cada cliente tiene su propio datastore
de HealthImaging, su propio prefijo en S3 y (a futuro) su propio dominio — pero
todos corren exactamente los mismos bytes del bundle.

Eso funciona porque webpack **no bundlea** el config: lo copia tal cual y lo carga
un `<script src>` aparte. Así que el único archivo que distingue a un cliente se
inyecta al publicar, no al compilar:

```
app-config.js  =  config/genx-base.js  +  config/clients/{slug}.js
```

```bash
scripts/build.sh v3                                                  # una vez
scripts/publish-client.sh mx-san-mungo v3 genx-viewer <dist-id>      # por cliente
```

> ⚠️ **El `DatastoreID` NO se puede pasar por URL** — esta sección afirmaba lo
> contrario y era falso. El extension ignora el query param: su constructor hace
> `{...window.healthlake, ...qidoConfig.healthlake}`, o sea el config del build
> gana siempre. Eso hoy es la garantía de aislamiento: un usuario no puede
> reapuntar el visor al datastore de otro cliente editando la barra de direcciones.

Detalle completo, alternativas descartadas y plan pendiente:
[`GENX-MULTI-TENANT.md`](GENX-MULTI-TENANT.md).

## Personalización

| Qué | Dónde |
|---|---|
| Logo del header | `platform/app/public/assets/genx-logo.png` |
| Favicon | `platform/app/public/assets/genx-icon.png` |
| Título de la página | `platform/app/public/html-templates/index.html` |
| Colores/tema | `platform/ui/tailwind.config.js` y `platform/ui/src/tailwind.css` |
| Configuración general | `platform/app/public/config/genx-base.js` |
| Lo que cambia por cliente | `platform/app/public/config/clients/{slug}.js` |

Logo y título son por cliente sin recompilar: el delta puede pisar `whiteLabeling`
y `document.title`. Lo demás (comportamiento del visor) va en el base y se comparte.

## Actualizar desde OHIF upstream

```bash
git fetch upstream
git merge upstream/master
```

Resolver conflictos si los hay (típicamente en archivos de config que personalizamos).
