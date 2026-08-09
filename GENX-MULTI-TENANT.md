# GenX Viewer — Multi-cliente (compilar 1, publicar N)

Cómo un mismo visor sirve a clientes distintos, cada uno con su propio datastore
de AWS HealthImaging.

**Estado:**

| Fase | Qué | Estado |
|---|---|---|
| 0 | Corregir la doc que prometía `?DatastoreID=` | ✅ Hecho |
| 1 | Config por cliente + build/publish partidos | ✅ Hecho |
| 2 | Distribución CloudFront por cliente + el RIS emite el enlace | ⬜ Pendiente |
| 3 | Subir la cuota de concurrencia de Lambda | ⏸️ **Pausada** por decisión |
| 4 | Autorizar el proxy | ⏸️ **Pausada** por decisión |

---

## Modelo de despliegue

Un cliente = una base de datos + una instancia EC2 + un datastore de
HealthImaging + (a futuro) un dominio propio. Un cliente puede tener N sucursales,
que **comparten** su datastore.

Lo que se comparte entre clientes, deliberadamente:

| Compartido | Por cliente |
|---|---|
| Código y pipeline de build | Prefijo en S3 |
| **Proxy Lambda + su IAM** | Distribución CloudFront + dominio + certificado |
| Bundle del visor (mismos bytes) | Un archivo de config de ~10 líneas |

El proxy es el recurso que de verdad vale la pena compartir, y ya era
multi-tenant sin cambios: `core.js:20-37` saca el `DatastoreID` del query string
de cada request, y el IAM está scopeado a `datastore/*` de la cuenta
(`infra/modules/viewer-proxy-lambda/main.tf:51`).

---

## 1. Diagnóstico (verificado en código)

| Capa | ¿Genérica? | Evidencia |
|---|---|---|
| Infra (Lambda, IAM, CloudFront, S3) | ✅ Ya lo era | IAM sobre `datastore/*`; alta de cliente sin `tofu apply` en el proxy |
| Proxy (`viewer/proxy/core.js`) | ✅ Ya lo era | Datastore por request (`core.js:20-37`) |
| Bundle del visor | ❌ Era **una línea** | `aws-healthimaging-v2.js:78`, datastore literal |

### La palanca: el config no está en el bundle

- `.webpack/webpack.pwa.js:117-119` copia el `APP_CONFIG` elegido tal cual, renombrado a `app-config.js`.
- `html-templates/index.html:190` lo carga con un `<script src>` aparte.
- El resto de `config/**` está **excluido** de la copia (`webpack.pwa.js:102`), así que los deltas de cliente nunca se publican.

De ahí sale la propiedad central:

> Con el mismo `PUBLIC_URL`, el build de dos clientes es **byte por byte
> idéntico salvo `app-config.js`**. Ese archivo se puede inyectar al **publicar**.

Por eso "un visor por cliente" **no cuesta un build por cliente**. Compilar y
publicar son pasos distintos, y solo el segundo sabe de clientes.

### La restricción

`ohif-aws-healthimaging` es dependencia npm (`platform/app/package.json:92`), no
está vendorizada. Parchearla exige fork o `yarn patch` y es deuda en cada bump.
**Nada de este diseño la toca.**

---

## 2. La decisión de diseño

Hay dos formas de que el visor sepa a qué datastore apuntar:

- **Runtime** — leerlo de la URL (`?DatastoreID=`), de `sessionStorage`, o de un `fetch`.
- **Estático** — hornearlo en el `app-config.js` que se publica para ese cliente.

**Se eligió el estático.** El runtime solo gana si un mismo sitio tiene que servir
a varios clientes; con dominio por cliente, ese caso no existe — y el estático
elimina tres modos de fallo:

| Riesgo | Con param en URL | Con config por cliente |
|---|---|---|
| Alguien entra sin el param | Error o lista vacía | **No existe el modo de fallo** |
| Ver el datastore de otro cliente | A un query param de distancia | El bundle publicado **no contiene** el ID de nadie más |
| `cliente.viewer/?study=1.3.3` | Hay que arrastrar el datastore en cada link | La URL solo lleva el estudio |

### El detalle irónico

El extension **ignora** cualquier `DatastoreID` que venga por URL: su constructor
hace `{...window.healthlake, ...qidoConfig.healthlake}` (`DicomTreeClient.ts:60-62`),
o sea el config del build gana. El listado usa `config.datastoreID` directo
(`loadImageSets.ts:84`) y el metadata igual (`DicomTreeClient.ts:131`).

Eso arrancó documentado como limitación. En este diseño **es la garantía de
aislamiento**: no hay perilla que girar desde el navegador.

---

## 3. Opciones evaluadas

| Opción | Costo | Veredicto |
|---|---|---|
| **A.** Config estático por cliente, inyectado al publicar | 1 build + N copias de un archivo de 10 líneas | ✓ **Elegida** |
| **B.** `datastoreID` resuelto en runtime desde la URL | Reintroduce los tres riesgos de arriba | ✗ Resuelve un problema que este modelo no tiene |
| **C.** Slug corto + mapa `slug→datastore` público | El mapa es el llavero completo mientras el proxy no autorice, y filtra la lista de clientes | ✗ |
| **D.** `app-config.js` resuelve por `fetch` al API | Dependencia de red **antes** de que arranque el visor | ✗ Innecesario |
| **E.** Un build completo por cliente | N builds, N rollbacks y **version skew**: cliente A en el build de marzo, B en el de agosto | ✗ El almacenamiento es barato; la matriz de versiones no |

E es la intuición correcta ("un visor por cliente") con la implementación cara.
A entrega lo mismo compilando una sola vez.

---

## 4. Cómo funciona (Fase 1, implementada)

```
app-config.js publicado  =  config/genx-base.js  +  config/clients/{slug}.js
```

```bash
scripts/build.sh v3                                              # UNA vez
scripts/publish-client.sh mx-san-mungo v3 genx-viewer <dist-id>  # por cliente
```

| Archivo | Rol |
|---|---|
| `config/genx-base.js` | Todo lo compartido. **Aquí van los cambios de comportamiento.** |
| `config/clients/{slug}.js` | Solo lo que distingue al cliente: datastore, título, logo |
| `scripts/build.sh` | Compila. No sabe de clientes; el `dist/` sale sin datastore |
| `scripts/publish-client.sh` | Compone el config, valida y sube. No compila |
| `scripts/deploy-version.sh` | **Legacy**, solo para republicar v1/v2 |

`aws-healthimaging.js` (v1) y `aws-healthimaging-v2.js` (v2) quedan **congelados**:
son el config de los artefactos ya desplegados y existen para rollback.

**No dupliques el base por cliente.** Son ~100 líneas de decisiones caras de
re-derivar (`stackRetrieveOptions`, `httpErrorHandler`, el razonamiento de
`maxNumRequests`). N copias divergen en meses.

### Los cuatro gates de `publish-client.sh`

Verificados en seco (`--dry-run`), los cuatro cortan antes de tocar S3:

1. **No hay `dist/`** → manda a correr `build.sh`.
2. **El `dist/` se construyó con un config legacy** (falta el marcador `GENX_CONFIG_BASE`) → rechaza. Publicar eso a un cliente le mostraría el datastore de otro.
3. **No existe el delta del cliente** → rechaza.
4. **El config compuesto no es publicable** → lo ejecuta en Node antes de subirlo, así que un error de sintaxis en el delta o un `datastoreID` sin asignar se detectan acá, no en producción.

`genx-base.js` además loguea un error explícito si arranca sin datastore, para
cubrir las subidas a mano que se saltan el script.

### Por qué el slug no aparece en la URL

S3: `s3://{bucket}/clients/{slug}/{version}/` — URL: `https://{dominio}/{version}/viewer`.

`PUBLIC_URL` se hornea en `index.html` y en las rutas de assets, así que **tiene
que ser igual para todos los clientes** o el build deja de ser único. Por eso el
prefijo por cliente vive en `origin_path` de su distribución, no en la ruta que ve
el navegador.

Consecuencia: **ese prefijo no es alcanzable hasta que exista la distribución por
cliente (Fase 2).** La invalidación usa la ruta del navegador (`/{version}/*`),
no la llave de S3, porque CloudFront quita `origin_path` antes de ir al origen.

---

## 5. Fase 2 — Lo que sigue

**Infra:** una distribución CloudFront por cliente, con su dominio, su
certificado ACM y `origin_path = /clients/{slug}`, todas apuntando al mismo bucket
y al mismo proxy Lambda compartido. Es aditivo y encaja con el patrón por hospital
que ya existe en `infra/hospitals/`. Habrá que ajustar la CloudFront Function del
SPA fallback, que hoy asume `/vN/` en la raíz.

**RIS:** el front emite `https://{dominio-cliente}/{version}/viewer?StudyInstanceUIDs=…`
— sin datastore en la URL. La URL base va como `clinic_setting` (escalar, cambia
casi nunca, se lee constantemente), que es lo que permite mover un cliente de `v3`
a `v4`, o hacer rollback, sin tocar código de Flutter. Hoy nada en Flutter
construye URLs del visor, así que no hay nada que romper.

---

## 6. Lo que queda abierto (pausado por decisión)

### Fase 3 — Cuota de concurrencia de Lambda ⏸️

Son **10 ejecuciones concurrentes a nivel cuenta** (`L-B99A9384`, nunca subida).
Cada frame es una invocación: una serie de 96 frames son 96 invocaciones con
máximo 10 en vuelo. Hoy un solo radiólogo ya roza el techo, y **la cuota se
comparte entre todos los clientes** — una serie de uno puede dejar sin frames a
otro. No es degradación gradual: son 429 y frames que no pintan.

Sigue siendo el bloqueante real antes de tener dos clientes con tráfico. Subirla a
1000 es una solicitud a AWS, gratis, y tarda días. Después hay que re-medir antes
de tocar `maxNumRequests`.

### Fase 4 — Autorizar el proxy ⏸️

El Function URL es `authorization_type = "NONE"` y su rol puede leer **cualquier
datastore de la cuenta**.

El config estático **redujo** el riesgo: ningún ID ajeno circula en URLs, links ni
logs, y hace falta conocer un par `DatastoreID` + `ImageSetID` para llegar a nada.
Pero no lo cerró: el endpoint sigue siendo público y sirve cualquier datastore.
Para un sistema con PHI eso hay que cerrarlo antes de que haya volumen real.

Cuando toque, el paso correcto es un **ticket opaco y firmado** que emita el API
de GenX (datastore + estudio + expiración) y que **el proxy valide**. Enmascara y
autoriza en el mismo movimiento.

> **Sobre enmascarar el ID (base64 y similares):** no vale la pena. Es reversible
> en un clic y crea la impresión de que hay protección donde no la hay, lo que
> envenena el razonamiento sobre lo que se construya encima. Además, con el config
> estático el datastore ya no viaja en la URL — no hay nada que enmascarar.

### Optimización conocida

CloudFront no cachea `/api/*` (a propósito, `Managed-CachingDisabled` — ver
`infra/viewer/README.md`). Con N clientes es N veces el mismo costo por frame. La
clave natural sería `DatastoreID` + `ImageSetID` + `frameID`, que es tenant-safe
por construcción.

---

## 7. Lo que NO hacer

- **Un build por cliente.** Version skew garantizado, y no compra ningún aislamiento que el config por publish no dé.
- **Meter el slug en `PUBLIC_URL`.** Rompe el build único; va en `origin_path`.
- **Copiar `genx-base.js` a `clients/{slug}.js`.** El delta lleva solo diferencias.
- **Parchear `ohif-aws-healthimaging`.** Es dependencia npm; el parche es deuda en cada bump.
- **Publicar a mano con `aws s3 cp`.** Se salta los cuatro gates — incluido el que evita publicarle a un cliente el datastore de otro.
