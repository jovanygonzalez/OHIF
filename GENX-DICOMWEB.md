# GenX Viewer — DICOMweb directo contra AHI (v4)

Por qué el visor dejó de hablar con un proxy que firma SigV4 y empezó a hablar
DICOMweb directo con AWS HealthImaging, qué se ganó, **qué se rompió sin querer**
y cómo se cierra.

> **Estado (2026-08-19, rama `viewer-dicom-web`):** el **paso 1 está aplicado y
> verificado E2E en navegador** — behavior `/datastore/*` en las dos
> distribuciones, config del cliente en raíz relativa, v4 republicado, y un
> estudio real abriéndose completamente same-origin, sobre h2, sin un solo
> preflight. **Paso 2 (medir) también hecho, y el resultado es un empate:** v3 y
> v4 rinden igual porque el enlace de la clínica está saturado — ver §9 antes de
> sacar conclusiones de rendimiento de este documento. **v3 sigue desplegado y
> sin tocar**, sirviéndose por `/api/*`.

Documentos hermanos:
[`GENX.md`](GENX.md) (arquitectura v3) ·
[`GENX-MULTI-TENANT.md`](GENX-MULTI-TENANT.md) (compilar 1, publicar N) ·
[`cloud-functions/ahi-oidc-authorizer/README.md`](../cloud-functions/ahi-oidc-authorizer/README.md) (la Lambda) ·
[`infra/viewer/README.md`](../infra/viewer/README.md) (la infra).

---

## 1. El error de lectura que motiva este doc

La migración v3→v4 movió **dos ejes independientes en el mismo cambio**, y al
medir el resultado se atribuyó todo a uno solo. Separarlos es la única forma de
decidir bien:

| Eje | v3 | v4 (hoy) | Quién gana |
|---|---|---|---|
| **Quién autoriza** | Lambda proxy firma SigV4 y **transporta los bytes** | Lambda authorizer valida el JWT; los bytes van AHI→navegador | **v4** |
| **Por dónde viajan los bytes** | Navegador → CloudFront (same-origin, h2) → Lambda → AHI | Navegador → AHI directo (cross-origin, sin CDN) | **v3** |

El primero avanzó, el segundo retrocedió. De ahí sale la conclusión central de
este documento:

> **CloudFront era el camino de rendimiento; el proxy Lambda era una caseta de
> peaje instalada encima.** Se puede conservar la carretera y quitar la caseta.
> No hay que elegir entre DICOMweb y CloudFront — son ortogonales, y la
> combinación correcta es **las dos**.

`v4 + CloudFront` domina a v3 en los dos ejes. `v4 sin CloudFront` —lo que está
armado ahora mismo— es la única de las cuatro combinaciones que pierde.

---

## 2. Trampa: v4 NO elimina la Lambda por request

Esta fue la premisa con la que se decidió migrar ("evitar que una Lambda firme
cada frame") y es **falsa tal como está enunciada**. AHI invoca al authorizer en
cada request DICOMweb — está escrito en el README de la propia Lambda.

Lo que cambia no es el **número** de invocaciones, es **qué hace cada una**:

| | v3 (proxy) | v4 (authorizer) |
|---|---|---|
| Duración | lo que tarde en bajar+subir el frame | **1.3 ms** tibio, con token en cache |
| ¿Toca los bytes? | sí, **es el tubo** | no |
| Techo por respuesta | **6 MB** (límite de payload de Lambda) | ninguno |
| Throughput medido | **110 Mbps** vs 324 del camino a S3 en el mismo enlace | el de AHI |
| Concurrencia | 1 invocación **por frame** | 1 por request, de 1.3 ms |

El renglón de concurrencia es el argumento decisivo, y no es de latencia sino de
escala. Con `maxNumRequests.interaction = 25` (`config/genx-base.js`), cada
radiólogo mantiene hasta 25 invocaciones concurrentes. La quota de Lambda es de
**1000 y es de CUENTA, compartida entre todos los clientes**: ~40 radiólogos
simultáneos la saturan y empiezan los 429, que es *un frame que no pinta*. Ya
pasó una vez —81 throttles en una sola carga— cuando la quota era de 10.

**v3 tiene un techo de escala estructural que v4 no tiene.** Esa es la razón
correcta para migrar, no la que se creyó.

Hay una segunda razón que tampoco es de rendimiento: el Function URL de v3 es
`auth_type = NONE`, público, y su rol IAM puede leer **cualquier datastore de la
cuenta** (`GENX-MULTI-TENANT.md` §7, "Fase 4 ⏸️ pausada"). Con PHI real eso hay
que cerrarlo. v4 lo cierra por construcción: token obligatorio + un rol por
datastore vía `DATASTORE_ROLE_MAP`.

---

## 3. Lo que v4 rompió: el camino same-origin

```
v3:  navegador → CloudFront (/api/*) → Lambda → AHI     ← mismo origen, h2, backbone AWS
v4:  navegador ─────────────────────────────→ AHI       ← otro origen, sin CDN, RTT completo
```

Apuntar el config del cliente a `https://dicom-medical-imaging.us-east-1.amazonaws.com`
deshizo, sin que nadie lo notara, la fase que `GENX-MULTI-TENANT.md` §8 ya tenía
medida: **el end-to-end pasó de 13.2 s a 5.6 s** justamente por el same-origin
por CloudFront combinado con `maxNumRequests`. Lo que se pierde al ir directo:

- **Preflight CORS por URL.** Un `GET` que lleva header `Authorization` **no es
  una petición simple**, así que el navegador manda un `OPTIONS` antes. AHI lo
  responde con `Access-Control-Max-Age: 172800` (48 h, verificado), pero **la
  caché de preflight se llavea por URL**: cada frame tiene URL propia, así que
  cada frame nuevo paga igualmente su viaje extra a us-east-1. En una serie de
  96 frames son 96 round-trips que same-origin borra por completo.
- **Terminación TLS en el edge cercano.** Directo se paga el RTT completo
  clínica→us-east-1 en cada conexión nueva, en vez de un salto corto al POP más
  un backbone tibio de AWS hasta el origen.

> **CORRECCIÓN (verificada 2026-08-19).** Una versión anterior de este documento
> listaba también "se pierde el multiplexado HTTP/2". **Es falso:** el endpoint
> de AHI negocia `h2` por ALPN igual que CloudFront —comprobado con
> `openssl s_client -alpn h2,http/1.1` contra los dos hosts—, así que el pool de
> 25 en vuelo sí multiplexa aunque se vaya directo. Eso **no** cambia la decisión
> (el preflight y la terminación TLS siguen siendo reales), pero sí **baja la
> ganancia esperada** respecto de lo que se creía. Razón de más para que el
> paso 2 sea medir y no asumir. El caso de v1 —donde el HTTP/1.1 del Function
> URL sí capaba a 6 en vuelo— era distinto y no aplica acá.

### Advertencia de método (vale más que cualquier número de este doc)

Las mediciones que motivaron esta sección se tomaron con un enlace que varió
muchísimo entre corridas —122 KB/s en un momento malo, 2.9 MB en 1.5 s en uno
bueno—. **Cualquier comparación v3 vs v4 tiene que ser alternada dentro de la
misma ventana de tiempo** (v3, v4, v3, v4), nunca dos bloques separados. Dos
bloques miden el enlace, no la arquitectura.

---

## 4. El arreglo: CloudFront delante de AHI

No hay que volver al proxy. Se agrega AHI como **segundo origen** de la misma
distribución, igual que hoy `/api/*` apunta al Lambda, y el config del cliente
usa una ruta relativa.

En este stack sale más barato de lo que parece, por una propiedad de las URLs:

```
AHI DICOMweb:  https://dicom-medical-imaging.us-east-1.amazonaws.com/datastore/{id}/studies/...
Visor (S3):    https://{dominio}/v4/...
```

Los paths de AHI ya empiezan con `/datastore/`; los del visor, con `/vN/`. **No
se pisan.** Entonces `path_pattern = "/datastore/*"` funciona **sin CloudFront
Function, sin reescritura de path y sin `origin_path`** — a diferencia de
`/api/*`, que sí necesitaba que `proxy/lambda.js` recortara el prefijo. El
acoplamiento de tres puntas que documenta `GENX.md` (path pattern ↔ `PATH_PREFIX`
↔ `wadoRoot`) desaparece: quedan dos, y coinciden por construcción.

Lo que hay que tocar:

| Archivo | Cambio |
|---|---|
| `infra/modules/viewer-site/main.tf` | `origin` nuevo (`dicom-medical-imaging.{region}.amazonaws.com`) + `ordered_cache_behavior` con `path_pattern = "/datastore/*"` |
| `infra/modules/viewer-client-site/main.tf` | **Lo mismo.** Los dos módulos o ninguno |
| `viewer/platform/app/public/config/clients/{slug}.js` | `var root = '/datastore/{id}'` en vez de la URL absoluta |

Parámetros del behavior nuevo:

- `cache_policy_id` → **`Managed-CachingDisabled`** para arrancar. Cachear es un
  cambio aparte y tiene una trampa propia, ver §7.
- `origin_request_policy_id` → **`Managed-AllViewerExceptHostHeader`**, la misma
  que ya usa `/api/*`. Eso responde sola la duda de si CloudFront reenvía el
  header `Authorization`: **reenvía todos los headers del viewer excepto `Host`**,
  que reemplaza por el dominio del origen — que es exactamente lo que AHI
  necesita para el SNI.
- `allowed_methods` → `["GET", "HEAD", "OPTIONS"]`. DICOMweb de lectura es todo
  GET; **no** hace falta el set completo con POST que exige el proxy.
- **NADA de `function_association`**, por la misma razón que `/api/*`:
  `spa-fallback.js` reescribe cualquier ruta sin extensión al `index.html` de su
  prefijo, y convertiría `/datastore/{id}/studies/{uid}` en `/datastore/index.html`.

**Cero cambios en el bundle del visor.** El config no se bundlea (webpack lo
copia tal cual), que es la propiedad de la que vive todo el diseño multi-cliente.

---

## 5. Lo que hay que verificar, no asumir

- ~~**`BulkDataURI` absolutos.**~~ **RESUELTO (2026-08-19).** El `/metadata` de
  WADO-RS de AHI **no emite `BulkDataURI` en absoluto** — cero ocurrencias en
  70 KB de metadata de una serie MG, y cero menciones al hostname de AHI. En una
  sesión completa (99 requests: login, lista, metadata y frames) **ni un solo
  request salió del dominio de CloudFront**, salvo los dos de Keycloak. No hace
  falta tocar `startsWith` ni `relativeResolution`.
- **`maxNumRequests: 25` quedó con el razonamiento obsoleto.** El comentario en
  `genx-base.js` lo justifica contra la quota de Lambda, que en v4 ya no aplica
  al camino de los bytes. Restaurado el same-origin, ese número se puede subir —
  **midiendo**, y sabiendo que ahora el techo lo pone AHI y no una quota de
  cuenta.
- **`price_class = "PriceClass_100"`** en los dos módulos. Vale la pena confirmar
  contra la tabla de regiones de precio vigente si cubre edges en México; si no
  los cubriera, para una clínica mexicana el POP más cercano estaría en EE. UU. y
  parte del beneficio de terminar TLS cerca se diluye. **No verificado** — es una
  pregunta abierta, no un hallazgo.

---

## 6. El verde en ultrasonido: es metadata, no transporte

Un ultrasonido a color se renderiza **verde**. Es un eje aparte y **no debe
influir en la decisión de arquitectura**.

Evidencia recogida trayendo el mismo frame por los dos caminos:

| Camino | Primeros píxeles | Lectura |
|---|---|---|
| ELE sin comprimir (3,439,960 B) | `1,128,127` | Y=1, Cb=128, Cr=127 — negro correcto en YBR |
| HTJ2K decodificado (351,869 B) | `0,135,0` | verde puro |

El dato que AHI guarda **es válido** —el ELE lo demuestra— y el estudio ya estaba
almacenado como HTJ2K, así que no hay transcodificación de por medio. El buffer
llega del tamaño exacto (1260×910×3, interleaved) con los valores mal.

**Hipótesis (no confirmada):** AHI reporta en el `/metadata` de WADO-RS el
`PhotometricInterpretation` **original** (`YBR_FULL_422`), mientras que el
codestream HTJ2K decodifica a resolución completa con su propia transformada de
componentes. DICOM PS3.5 pide `YBR_ICT`/`YBR_RCT` para JPEG 2000; cornerstone
decide si convierte —y si desempaqueta 4:2:2— según ese campo, y con el valor
heredado hace lo incorrecto. Encaja con el síntoma exacto: *tamaño correcto,
valores mal*.

Si la hipótesis es correcta, **el arreglo es normalizar un campo de metadata, no
forkear el decoder ni pedir ELE**.

**El experimento que lo decide, y hay que hacerlo antes de tocar código:** abrir
ese mismo ultrasonido en **v3**, que sigue desplegado. v3 obtiene el metadata por
la ruta nativa de AHI (`GetImageSetMetadata`, vía el extension propietario), no
por WADO-RS.

| Resultado en v3 | Conclusión |
|---|---|
| Se ve **bien** | La diferencia está en el metadata → hipótesis viva, arreglo barato |
| Se ve **verde** | El bug es de cornerstone con HTJ2K de AHI y **no lo introdujo esta migración** |

**Radio de impacto: solo color.** CT, MR, CR y mamografía son monocromos y ya
funcionan (y pesan 6.8× menos por el `acceptHeader`). El ultrasonido es el caso
afectado. Weasis lo abre bien porque no pasa por esta ruta de decodificación.

**Lo que NO conviene hacer como parche:** pedir ELE para color. Es correcto pero
son ~10× más bytes (3.4 MB vs 350 KB por frame); en un cine de ultrasonido eso es
peor negocio que el verde. Y el `acceptHeader` es estático, así que variarlo por
instancia exigiría tocar el hook `beforeSend`, no config.

---

## 7. La ganancia que solo v4 habilita: caché de frames en el edge

Vale la pena registrarla porque es la respuesta a "aprovechar al máximo la nube",
y **v3 no puede llegar ahí ni en principio**.

En v3 los identificadores viajan en el **query string**
(`?DatastoreID=…&ImageSetID=…&frameID=…`). Por eso hay tres comentarios en la
infra explicando que reusar `Managed-CachingOptimized` ahí —que descarta el query
string— colapsaría todos los frames de una instancia en una sola entrada y
serviría **la imagen equivocada, en silencio**.

En DICOMweb el path identifica el frame por completo:

```
/datastore/{ds}/studies/{st}/series/{se}/instances/{in}/frames/{n}
```

La clave de caché es trivial y es tenant-safe por construcción. **El cuidado a
tener es el opuesto, y es serio:** un *hit* de caché **no invoca al authorizer**,
así que cachear por path desnudo convierte la URL en una credencial — cualquiera
que la conozca lee PHI sin token. La mitigación es incluir el header
`Authorization` en la clave de caché mediante una cache policy propia: baja el
hit rate entre usuarios, pero conserva la reutilización dentro de una sesión
(scroll, cine, reabrir el estudio), que es donde está el volumen.

Es un cambio deliberado y aparte, con su propia verificación. No entra en el
paso 1.

---

## 8. Prerrequisito de producción que v3 no tenía

`genx-base.js` apunta hoy a un túnel efímero:

```js
authority: 'https://…….trycloudflare.com/realms/genx'
```

**v4 no puede ir a producción hasta que Keycloak tenga una URL pública estable**,
porque el authorizer corre en AWS y tiene que leer el JWKS. Es el único costo
genuino de v4 frente a v3, y es de infra, no de arquitectura.

Tres cosas se mueven **juntas o nada autentica**: `oidc.authority` en
`genx-base.js`, `oidc_issuer` en `infra/viewer/terraform.tfvars`, y `KC_HOSTNAME`
del Keycloak. Y `KC_HOSTNAME` cambia el `iss` de **todos** los tokens del realm,
no solo los del visor — el filtro JWT de Envoy tiene el issuer escrito a mano
(`api/containers/envoy/envoy.yaml`) y empieza a rechazar los tokens de la app web
con 401. Detalle completo en el README del authorizer.

---

## Orden de trabajo

1. ✅ **CloudFront delante de AHI** (`/datastore/*`, §4) — aplicado y verificado
   E2E el 2026-08-19 (`tofu apply`: 0 added, 2 changed, 0 destroyed). Smoke con
   sesión real (Keycloak PKCE → lista → mamografía de 82 frames):

   | Qué | Evidencia |
   |---|---|
   | Todo va same-origin | 99 requests, **cero** al hostname de AHI (solo los 2 de Keycloak salen del dominio) |
   | Cero preflight CORS | ningún `OPTIONS`; el navegador marca los frames `sec-fetch-site: same-origin` |
   | HTTP/2 | pseudo-headers `:authority` / `:method` / `:path` en cada request |
   | CloudFront reenvía el JWT | frames y metadata en 200 con `authorization: Bearer …`; sin él, `Missing Authentication Token`; con uno basura, `Invalid or Expired token` — **idéntico a AHI directo** |
   | El `acceptHeader` sobrevive el salto | request y respuesta con `type="image/jphc"; transfer-syntax=…4.202`; frame de 2.3 MB, **no** los ~20 MB de ELE |
   | La imagen pinta | mamografía monocroma correcta |
2. ✅ **Medido** (2026-08-19) — ver §9. Resultado incómodo pero claro: **v3 y v4
   son indistinguibles en este enlace**, porque el enlace es el cuello de
   botella. La justificación de v4 es estructural, no de velocidad.
3. **El verde**, empezando por abrir el ultrasonido en v3 (§6).
4. **Keycloak público estable** (§8) — en paralelo, es el gate de producción.
5. *(Después, opcional y grande)* **Caché de frames en el edge** (§7).

---

## 9. La medición (2026-08-19) — v3 y v4 empatan, y por qué

Mismo estudio, misma serie (`LMLO CANOVA`, 82 instancias), mismo navegador, misma
distribución de CloudFront, corridas alternadas dentro de la misma ventana, y
**las dos medidas con el mismo método** (trace de DevTools → eventos
`ResourceSendRequest`/`ResourceFinish`, que es el único que ve los frames:
cornerstone los descarga dentro de Web Workers y un hook del hilo principal no
los captura).

| | frames | fase de frames | datos | p50/frame | p95/frame | throughput | 1er frame | proto |
|---|---|---|---|---|---|---|---|---|
| **v3** (proxy `/api`) | 81 | 15 196 ms | 176.5 MB | 3 828 ms | 4 655 ms | **97.4 Mbps** | 781 ms | h2 |
| **v4** (CloudFront→AHI) | 81 | 15 699 ms | 176.5 MB | 3 733 ms | 4 770 ms | **94.3 Mbps** | 941 ms | h2 |

**Diferencia: ~3%. Es ruido.**

### Por qué empatan: el enlace está saturado

176.5 MB en ~15.2 s son ~97 Mbps, y ese es justamente el techo del enlace de la
clínica (el doc de v3 ya citaba "un enlace de 93 Mbps"). **Esta carga de trabajo
es throughput-bound**, y lo que compra CloudFront —eliminar un preflight por URL,
terminar TLS cerca— son ganancias de **latencia**. Cuando el cuello de botella es
el ancho de banda, esas ganancias no aparecen en el cronómetro.

Tres consecuencias que conviene no olvidar:

- **La regresión que motivó todo este paso probablemente nunca fue medible en
  este enlace.** El "v4 se siente más lento" que arrancó el análisis no se
  reproduce con números.
- **El 3× de throughput que el doc de v3 le atribuía al proxy tampoco se
  reproduce.** v3 dio 97.4 Mbps, v4 94.3 — el proxy no era un cuello de botella
  de ancho de banda acá.
- **CloudFront seguiría importando donde la latencia domina**: enlaces rápidos
  lejos de us-east-1, estudios de pocos frames, y el tiempo hasta la primera
  imagen. Esta medición no cubre ese caso.

### Lo que esto NO cambia

La razón para preferir v4 **nunca debió ser la velocidad**, y esta medición lo
confirma. Sigue en pie, intacto:

- v3 gasta **una invocación de Lambda por frame** contra una quota de **1000 de
  cuenta compartida entre clientes** — ~40 radiólogos simultáneos la saturan (§2).
- v3 expone un Function URL **público y sin autenticar** cuyo rol lee cualquier
  datastore de la cuenta.
- v3 arrastra un extension propietario y un proxy que traduce rutas.
- Solo v4 hace viable el caché de frames en el edge (§7), que **sí** atacaría el
  techo del enlace — sirviendo desde el POP en vez de cruzar a us-east-1.

Dicho de otro modo: el paso 1 no compró velocidad hoy, pero es el que deja el
camino donde el caché puede comprarla mañana.

## Lo que NO hacer

- **Volver a v3 por el problema de rendimiento.** El rendimiento lo daba
  CloudFront, no el proxy, y CloudFront se recupera sin el proxy. Hacer rollback
  reintroduce el techo de concurrencia y el Function URL público.
- **Creer que v4 quita la Lambda del camino.** Sigue habiendo una invocación por
  request; lo que se quitó es que la Lambda **cargue los bytes** (§2).
- **Pedir ELE para arreglar el verde.** ~10× más bytes por un bug que
  probablemente es un campo de metadata (§6).
- **Comparar v3 y v4 en ventanas de tiempo distintas.** Mide el enlace, no la
  arquitectura (§3).
- **Encender el caché de frames sin meter `Authorization` en la clave.** Un hit
  no invoca al authorizer: la URL pasaría a ser la credencial (§7).
- **Agregar el behavior de AHI a un solo módulo.** `viewer-site` y
  `viewer-client-site` tienen que decir lo mismo o los clientes reales se quedan
  sin la optimización, en silencio (§4).
