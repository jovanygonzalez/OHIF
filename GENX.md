# GenX Viewer — Visor DICOM (OHIF + AWS HealthImaging)

Fork de [OHIF Viewer](https://github.com/OHIF/Viewers) configurado para conectarse a AWS HealthImaging. Renderiza imágenes DICOM en HTJ2K directamente en el browser, sin servidor de aplicaciones.

## Arquitectura

```
Browser (OHIF estático)
   │
   ├── Visor: S3 + CloudFront (prod) / localhost:3000 (dev)
   │
   └── Datos: Proxy → AWS HealthImaging
              localhost:8089 (dev) / Lambda Function URL (prod)
```

El visor es un sitio estático (HTML/JS/CSS). El proxy es un servicio Node.js que firma requests con credenciales AWS y los reenvía a HealthImaging. Un solo proxy sirve a todos los hospitales — el `datastoreID` viene en cada request.

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
│   │   └── aws-healthimaging.js    # Configuración del datasource y branding
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

En `aws-healthimaging.js`, cambiar el endpoint:

```javascript
healthlake: {
  datastoreID: 'TU_DATASTORE_ID',
  endpoint: 'https://xxxxx.lambda-url.us-east-1.on.aws',
},
wadoRoot: 'https://xxxxx.lambda-url.us-east-1.on.aws',
```

## Cómo funciona el proxy

El proxy resuelve dos problemas:

1. **Credenciales**: El browser no puede tener credenciales AWS. El proxy firma los requests con `aws4` antes de reenviarlos.

2. **Reescritura de URLs**: OHIF genera URLs DICOMWeb estándar (`/studies/.../frames/1?...`), pero HealthImaging usa su propia API (`/datastore/{id}/imageSet/{id}/getImageFrame`). El proxy intercepta y reescribe automáticamente.

```
OHIF pide:  GET /studies/{uid}/series/{uid}/.../frames/1?DatastoreID=xxx&ImageSetID=yyy&frameID=zzz
Proxy hace: POST /datastore/xxx/imageSet/yyy/getImageFrame  { imageFrameId: "zzz" }
```

## Multi-hospital

Un solo deploy del visor y proxy sirve a todos los hospitales. Cada hospital tiene su propio HealthImaging datastore. El `datastoreID` se puede pasar por URL:

```
https://viewer.genx.com/viewer?StudyInstanceUIDs=...&DatastoreID=abc123
```

## Personalización

| Qué | Dónde |
|---|---|
| Logo del header | `platform/app/public/assets/genx-logo.png` |
| Favicon | `platform/app/public/assets/genx-icon.png` |
| Título de la página | `platform/app/public/html-templates/index.html` |
| Colores/tema | `platform/ui/tailwind.config.js` y `platform/ui/src/tailwind.css` |
| Configuración general | `platform/app/public/config/aws-healthimaging.js` |

## Actualizar desde OHIF upstream

```bash
git fetch upstream
git merge upstream/master
```

Resolver conflictos si los hay (típicamente en archivos de config que personalizamos).
