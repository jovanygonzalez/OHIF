# GenX Viewer — Multi-cliente (compilar 1, publicar N)

Cómo un mismo visor sirve a clientes distintos, cada uno con su propio datastore
de AWS HealthImaging.

**Estado:**

| Fase | Qué | Estado |
|---|---|---|
| 0 | Corregir la doc que prometía `?DatastoreID=` | ✅ Hecho |
| 1 | Config por cliente + build/publish partidos | ✅ Hecho |
| 2a | Distribución CloudFront por cliente | ✅ Aplicada y verificada E2E |
| 2b | El RIS emite el enlace | ✅ Hecho ([`docs/viewers.md`](../docs/viewers.md)) |
| 3 | Subir la cuota de concurrencia de Lambda | ✅ Hecho y medido (10 → 1000) |
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

### Trampa: `dist/app-config.js` sale minificado y sin salto de línea final

webpack corre Terser también sobre los assets **copiados**, no solo sobre los
bundleados. Así que el base llega al `dist/` en **una sola línea**, sin `\n` final
y sin comentarios. Un `cat base delta` pegaría el último token del base con el
primero del delta (`...,0)Object.assign(...`), rompiendo el archivo.

Por eso `publish-client.sh` compone con `\n;\n` en medio. Dos consecuencias más:

- El `app-config.js` **publicado no tiene comentarios**. El razonamiento vive en `config/genx-base.js`, no en lo que sirve producción.
- El delta **no** se minifica (se anexa después), así que en el archivo servido aparece tal cual, con sus comillas simples. Terser no renombra propiedades, por eso el `Object.assign` del delta sigue encontrando `dataSources[0].configuration.healthlake` en el base minificado.

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

## 5. Fase 2a — Distribución por cliente (escrita, falta aplicar)

`modules/viewer-client-site`: una distribución CloudFront por cliente, todas sobre
el **mismo** bucket, OAC, CloudFront Function y proxy Lambda. Lo único propio es
`origin_path = /clients/{slug}`.

Alta de un cliente = una entrada en `clients` de `infra/viewer/terraform.tfvars`
+ su delta de config. **No** se recompila el visor.

Dos cosas que resultaron más baratas de lo esperado:

- **El SPA fallback no necesitó cambios.** Opera sobre la ruta que ve el navegador (`/v3/viewer` → `/v3/index.html`) y CloudFront antepone `origin_path` después, así que el prefijo del cliente le es invisible.
- **No hace falta dominio propio para que funcione.** Cada distribución trae su `*.cloudfront.net`. `aliases` + certificado ACM (obligatoriamente en **us-east-1**) es un update in-place posterior, sin republicar nada.

Lo que sí hubo que tocar: la policy del bucket condicionaba `AWS:SourceArn` a una
sola distribución. Ahora enumera también las de cliente
(`client_distribution_arns`). **Si se olvida, el cliente recibe 403 de S3 en
todo.** Se enumeran explícitamente en vez de un `ArnLike` sobre `distribution/*`
para que dar de alta un cliente sea un cambio visible en el plan.

## 6. Fase 2b — El RIS emite el enlace ✅ Hecho

El enlace es `https://{dominio-cliente}/{version}/viewer?StudyInstanceUIDs=…` —
sin datastore en la URL, como se diseñó.

Lo que **cambió** respecto de lo que decía esta sección: la URL base **no** es un
`clinic_setting`. Vive en `viewers.base_url`, una fila del catálogo de visores.
La razón es que un visor resultó no ser un escalar de configuración sino una
**entidad** —tiene id, producto, URL, estado de habilitación y una relación con
los roles—, y el README de `clinic_settings` prohíbe explícitamente meter
entidades ahí. Se conserva la propiedad que motivaba la idea original: mover un
cliente de `v3` a `v4`, o hacer rollback, es cambiar una columna, sin tocar
Flutter.

Quien construye la URL es el backend (`internal/modules/viewer`), no el front:
el mismo camino tiene que consultar la disponibilidad del pixel data y, cuando
entren visores con token firmado, emitirlo.

**Doc completa: [`docs/viewers.md`](../docs/viewers.md).**

---

## 7. Lo que queda abierto (pausado por decisión)

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

## 8. Rendimiento — qué se midió y qué lo movió

Medido 2026-08-10 sobre un estudio real de 96 frames (CT), tres corridas por
variante, cada una en contexto de navegador aislado y frío. Medianas tibias:

| | Frames en vuelo | Fase de frames | End-to-end | Metadata por el cable |
|---|---|---|---|---|
| v1 (Function URL, HTTP/1.1) | 5 | 8 527 ms | 13 196 ms | 5.43 MB |
| v3 same-origin `/api`, pool default | 5 | 10 936 ms | 15 427 ms | 5.43 MB |
| \+ `maxNumRequests: 25` | 25 | 3 459 ms | 6 556 ms | 5.43 MB |
| \+ metadata gzip (proxy sin undici) | 25 | **3 279 ms** | **5 646 ms** | **348 KB** |

**End-to-end 13.2 s → 5.6 s (2.3×).**

Tres lecciones que costaron caro re-derivar:

1. **Same-origin/HTTP2 y `maxNumRequests` solo funcionan juntos.** Por separado
   cada uno es neutro o peor: la fase 1 sola fue una regresión de 2.5 s (fila 2),
   porque el p50 por frame *empeora* con el salto extra por el edge (353 → 470 ms)
   y no había paralelismo que lo amortizara. Subir el pool sin same-origin chocaba
   contra el tope de 6 conexiones de HTTP/1.1. La ganancia aparece al combinarlos.
2. **El techo observado nunca fue el que decía la doc.** Se creía que era la cuota
   de Lambda (10 concurrentes); medido, era el pool de cornerstone en **5**. La
   cuota importa para varios usuarios a la vez, no para una serie.
3. **El proxy inflaba el metadata 15.6×.** `fetch` (undici) anuncia gzip y
   descomprime solo; AHI devuelve el metadata gzip por contrato de API. El proxy
   descomprimía 348 KB a 5.43 MB y mandaba eso al navegador. Ver el comentario en
   `proxy/core.js`.

`studyPrefetcher` y `maxNumberOfWebWorkers` ya están configurados (ver
`genx-base.js`). Dos cosas que hay que saber antes de tocarlos:

- **`studyPrefetcher` NO precarga la serie que estás viendo.**
  `_getSortedDisplaySetsToPrefetch` filtra el display set activo a propósito. De
  la serie activa se encarga `stackContextPrefetch` de cornerstone, que ya venía
  activo por viewport (`CornerstoneViewportService.ts:841`) con una ventana
  deslizante de 2 antes / 2 después / +10 en la dirección del scroll. Nadie
  precarga una serie entera de golpe por diseño.
- **`displaySetsCount: 2` no acota el total.** Conforme termina un display set el
  servicio re-sincroniza y avanza al siguiente, así que en la práctica termina
  bajando el estudio completo. Medido en un estudio de tomosíntesis: **162 frames
  / 348 MB descargados en segundo plano sin ninguna interacción** (antes de
  activarlo: 6 frames). Eso es lo que se quiere para cine, pero significa que
  abrir un estudio pesado consume el estudio entero aunque el médico mire una
  sola imagen.

Lo que sigue rindiendo: **cold start** (una corrida fría dio 5 635 ms en
`retrieve-metadatatree` vs ~900 ms tibio — le pasa al primer estudio del día) y
los **~3× de throughput** que el camino del proxy pierde frente a S3 (110 vs
324 Mbps sobre la misma conexión, sin explicar). Subir la memoria de la Lambda a
1024 MB se probó y **no cambia nada** — es I/O puro, no CPU.

## 9. Lo que NO hacer

- **Un build por cliente.** Version skew garantizado, y no compra ningún aislamiento que el config por publish no dé.
- **Meter el slug en `PUBLIC_URL`.** Rompe el build único; va en `origin_path`.
- **Copiar `genx-base.js` a `clients/{slug}.js`.** El delta lleva solo diferencias.
- **Parchear `ohif-aws-healthimaging`.** Es dependencia npm; el parche es deuda en cada bump.
- **Publicar a mano con `aws s3 cp`.** Se salta los cuatro gates — incluido el que evita publicarle a un cliente el datastore de otro.
