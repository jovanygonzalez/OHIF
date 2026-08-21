# Autenticación y sesión del visor

> **Estado (21-ago-2026):** diagnóstico **revisado y corregido contra el código**.
> Fases 0, 1 y 2 **completas**. Keycloak vive en un hostname público estable
> (`https://auth.genx.mx`) servido por un túnel que ya corre como servicio de
> Windows, y el botón "Ver estudio" abre **v4**. La Fase 3 —migrar la app a
> *authorization code*— está desbloqueada y es lo único que queda.
>
> **Objetivo:** que abrir un estudio desde la app de GenX **no vuelva a pedir
> login**, y que cuando la sesión del visor se degrade el visor **lo diga**, en
> vez de romperse en silencio.

> ⚠️ **Antes de escribir código, lee la sección 9 (Lo que NO hacer).** Hay un
> atajo que funciona hoy, está soportado de fábrica por OHIF y es la tentación
> obvia. No es la solución, y lo explicamos ahí para que no se descubra dos veces.

Relacionados: [`GENX-DICOMWEB.md`](GENX-DICOMWEB.md) (§8, la URL pública de
Keycloak), [`GENX-MULTI-TENANT.md`](GENX-MULTI-TENANT.md) (compilar 1, publicar N),
[`../docs/security.md`](../docs/security.md) (los tres clientes del sistema),
[`../docs/viewers.md`](../docs/viewers.md) (el botón "Ver estudio").

---

## 0. Qué está hecho y qué no

| | Estado |
|---|---|
| **Fase 0 · Tiempos de sesión del realm** | ✅ aplicado al realm vivo **y** a `genx-realm.json` |
| **Fase 0 · Inactividad bloquea en vez de cerrar** | ✅ `idle_session_monitor.dart` + `auth_notifier` + `auth_storage` |
| **Fase 1 · Eventos de sesión del visor** | ✅ `OpenIdConnectRoutes.tsx` |
| **Fase 1 · Avisar los 401/403 de AHI** | ✅ `genx-base.js` → `window.genxSession` |
| **Fase 1 · Publicado** | ✅ 19-ago-2026, `mx-san-mungo` / `v4`. Verificado sirviendo desde CloudFront |
| **Fase 2 · Keycloak en hostname estable** | ✅ 20-ago-2026. `auth.genx.mx` por túnel Cloudflare **con nombre**. Login de la app verificado |
| **Fase 2 · Túnel como servicio de Windows** | ✅ 21-ago-2026. Servicio `cloudflared` en `RUNNING`. Runbook: [`../api/containers/keycloak/README.md`](../api/containers/keycloak/README.md) |
| **Fase 2 · v4 republicado contra `auth.genx.mx`** | ✅ 21-ago-2026. Verificado en el `app-config.js` que sirve CloudFront, no solo en el repo |
| **Fase 2 · El botón "Ver estudio" abre v4** | ✅ 21-ago-2026. `viewers.base_url` → `…/v4/viewer`, y el seed demo `00006` igual |
| **Fase 3 · RPC `GetMySession`** | ⬜ pendiente y **bloquea al resto**: hoy `user` y `branches` solo viajan dentro de `LoginResponse`, y ese mismo camino es el que mantiene el espejo `users` ([§6](#-fase-3--app-de-genx-a-authorization-code)) |
| **Fase 3 · App a authorization code + PKCE** | ⬜ pendiente. Solo web (no hay build de Windows en uso) |
| **Fase 3 · `logout` que revoque en Keycloak** | ⬜ pendiente, va con la Fase 3 |
| **Fase 3 · Retirar exenciones de `Login`/`RefreshToken`** | ⬜ pendiente. Dos listas que se mueven juntas: `auth.go` y `envoy.yaml` |

⚠️ El cableado de la Fase 1 **sí se observó en runtime** el 20-ago-2026 (así se
descubrió que el 403 del authorizer no significa lo que parecía — §5, hueco 4).
Lo que **no** se ha vuelto a observar es la versión **ya corregida**, la que
pregunta por `expires_at` en vez de por el status. Procedimiento en §8.

Con el hueco 6 cerrado, lo que la Fase 3 sigue aportando es el **primer** login
del día: hoy, la primera vez que alguien abre el visor tras expirar la sesión SSO
ve el formulario de Keycloak aunque ya esté dentro de la app. Eso solo lo quita
el authorization code en la app.

---

## 1. Qué originó el problema

El visor es una SPA **separada**, en otro origen (CloudFront) que la app de GenX.
Eso por sí solo no es un problema: es normal que cada app sea su propio cliente
OIDC. Lo que rompe la experiencia es que **no hay sesión compartida donde debería
haberla**.

La app de GenX autentica por **ROPC** (*Resource Owner Password Credentials*): el
usuario teclea sus credenciales en Flutter, viajan por gRPC al backend, y **Go**
las cambia con Keycloak servidor-a-servidor.

```go
// api/internal/modules/user/service/user_service.go:975
token, err := s.keycloakClient.Login(ctx, s.clientID, s.clientSecret, s.realm, username, password)
```

**El navegador nunca visita Keycloak.** Por lo tanto Keycloak nunca deja su cookie
de sesión SSO. Cuando el visor arranca y redirige a Keycloak para autenticarse,
Keycloak —con toda razón— no sabe quién es ese navegador, y muestra el formulario.

Dos clientes OIDC independientes + ninguna sesión de navegador = **dos logins**.

No hay atajo legítimo: **no existe forma soportada de convertir un token ROPC en
una cookie de sesión de navegador.** Cualquier intento es un truco. El único
camino al login único es que la app autentique por *authorization code* en el
navegador.

---

## 2. Lo que NO es (diagnósticos descartados, no los repitas)

| Hipótesis | Por qué es falsa |
|---|---|
| "Pide login porque está en internet abierto" | El prompt es idéntico en red privada. Falta una **sesión de navegador**, no aislamiento de red |
| "Es configuración del visor" | El bloque `oidc` de `genx-base.js` ya es correcto, y `genx-viewer` en Keycloak ya es público con PKCE `S256` |
| "El visor no sabe gestionar sesión" | Sí sabe: usa `oidc-client-ts` con `automaticSilentRenew`. Lo que faltaba era **cablear sus eventos** — ya está hecho (§5) |
| "Hay que meter el visor dentro de la app" | Un iframe/embed no crea la sesión de Keycloak que falta. Cambia el síntoma, no la causa |
| ~~"La renovación cuelga de un iframe que Chrome va a matar"~~ | **Falso, medido.** Va por refresh token. Ver §5, hueco 2 |

---

## 3. Estado verificado

Todo lo de esta tabla está **medido** contra el código o contra el realm vivo, no
inferido. Las incógnitas que quedan están en §10.

| Hecho | Dónde | Valor |
|---|---|---|
| Login de la app = ROPC | `api/…/user_service.go:975` | `keycloakClient.Login(...)` → password grant |
| Login del agente DICOM | `api/…/user_service.go:1054` | `GrantType: "password"` + scope `offline_access`. **Correcto para un cliente headless — NO tocar** |
| Cliente del backend | `api/.env` | `KEYCLOAK_CLIENT_ID=genx-api` |
| **`genx-api` en Keycloak** | realm `genx` | confidencial, `standardFlow=false`, `directAccessGrants=true`, sin PKCE → **hoy es incapaz de hacer authorization code** |
| **`genx-viewer` en Keycloak** | realm `genx` | público, `standardFlow=true`, PKCE `S256`, mapper `aud-genx-viewer`, redirects CloudFront + `localhost:3000` → **ya es correcto** |
| Validación del JWT en Go | `api/internal/middleware/auth.go:109` | firma (JWKS) + `exp`/`nbf`/`iat`. **No valida `iss` ni `aud`** |
| **Validación del JWT en Envoy** | `api/containers/envoy/envoy.yaml:98` | **sí valida `iss`**; el bloque `audiences` está **comentado** |
| Authorizer de AHI | `cloud-functions/ahi-oidc-authorizer/jwks.js:165` | acepta `azp` **o** `aud` contra la lista |
| Audiencias aceptadas por AHI | `infra/viewer/terraform.tfvars:23` | `["genx-api", "genx-viewer"]` |
| Cliente OIDC del visor | `viewer/platform/app/src/utils/nextOIDCClient.ts` | `UserManager` de `oidc-client-ts` **3.3.0**, code + PKCE forzado |
| Config OIDC del visor | `viewer/…/config/genx-base.js` | `automaticSilentRenew: true`, `revokeAccessTokenOnSignout: true`, scope `openid profile email` |
| `authority` (URL de Keycloak) | delta del cliente, commit `971f54cf25` | **cambiarla = republicar, sin recompilar** |
| **Vía de renovación** | `oidc-client-ts` 3.3.0 dist, l. 3101 | `if (user?.refresh_token) → _useRefreshToken`. **Refresh token, no iframe** |
| **`monitorSession`** | ídem, l. 2396 | default **`false`** → `addUserSignedOut` y compañía **nunca disparan** |
| **Reintento de la librería** | `SilentRenewService`, l. 2753 | solo ante `ErrorTimeout` del iframe (`_retryTimer.init(5)`). Un fallo de red del refresh **no se reintenta** |
| El token renovado sí llega a las peticiones | `DicomWebDataSource/index.ts:215,347,395` + `initWADOImageLoader.js:31` | `getAuthorizationHeader()` se llama **por request** |
| Dónde lanza Flutter el visor | `app/…/viewer/application/viewer_launcher.dart:79` | `launchUrl(url, webOnlyWindowName: '_blank')` → pestaña nueva, **sin handle de ventana** |
| Keycloak local | `api/containers/keycloak/docker-compose.yml` | `start-dev`, `KC_HOSTNAME=https://auth.genx.mx`, `KC_HOSTNAME_STRICT=false`, `KC_PROXY_HEADERS=xforwarded` |
| **Issuer del realm** | `.well-known/openid-configuration` | `https://auth.genx.mx/realms/genx` — **sin barra final**. Es el valor que se compara carácter a carácter en los 4 sitios de §7 |
| **Vía pública a Keycloak** | túnel `cloudflared` con nombre `genx-keycloak` | zona `genx.mx` en **Cloudflare** (nameservers movidos desde Namecheap), CNAME proxeado `auth.genx.mx` → `<UUID>.cfargotunnel.com` → `http://localhost:8180` |
| Vidas en el realm `genx` | Keycloak, **cambiado 19-ago-2026** | access token **900 s**, SSO idle **14400 s**, SSO max **43200 s** |

---

## 4. La arquitectura destino

**Keycloak es la única autoridad de sesión.** Cada app que vive en un navegador
—la app de GenX y el visor— es su propio **cliente OIDC público** con
authorization code + PKCE.

El usuario se autentica **una vez, en Keycloak, en el navegador**. A partir de
ahí:

- Abrir el visor es un **redirect invisible**: Keycloak reconoce su propia cookie
  de sesión y devuelve el código sin mostrar formulario.
- **Cada app renueva su propio token** con su propio refresh token. Ninguna
  depende de que la otra siga abierta, ni de pasarse nada entre sí.
- El logout en Keycloak las **cierra todas**.
- Los tokens **no viajan en URLs**, no pasan por el backend de GenX, y las
  contraseñas no salen de la página de Keycloak.

Lo importante de este diseño: **el visor casi no cambia**. Ya está bien construido.
El trabajo está en la app.

Beneficios que justifican el trabajo por sí solos, aparte del login único:

- Hoy las contraseñas de tus usuarios cruzan tu propio cable y las manipula tu
  backend. Con code flow eso desaparece.
- ROPC **salta el flujo de autenticación completo** de Keycloak: sin MFA, sin
  *required actions*, sin recuperación de contraseña, sin federación con un AD.
  Nada de eso se puede encender mientras el login sea password grant.

---

## 5. Los huecos, revisados

### Hueco 1 — No existe sesión SSO (causa del prompt) · **ABIERTO**

La app debe autenticar por **authorization code en el navegador** en vez de ROPC.
Es el único cambio estructural, y es el que crea la sesión que el visor luego
encuentra. Ver Fase 3.

### Hueco 2 — ~~La renovación cuelga de un iframe~~ · **NO EXISTE**

El encargo original suponía que `automaticSilentRenew` podía estar renovando por
un iframe con `prompt=none`, o sea con cookies de terceros, y que por lo tanto se
rompería solo con los cambios de Chrome. **Es falso, y está medido:**

- `oidc-client-ts` 3.3.0, línea 3101: `if (user?.refresh_token) return
  this._useRefreshToken(...)`. El iframe es el *fallback*, no la vía.
- `genx-viewer` no tiene `use.refresh.tokens=false` en Keycloak, así que sí emite
  refresh token.

La renovación va por refresh token y **no depende de cookies de terceros**. No
hay nada que arreglar acá.

### Hueco 2-bis — El verdadero acantilado estaba en el realm · **CERRADO**

Lo que sí era frágil era otra cosa, y el encargo no la vio:
`accessTokenLifespan` y `ssoSessionIdleTimeout` valían **ambos 1800 s**.
`oidc-client-ts` renueva 60 s antes del vencimiento, o sea a los 1740 s, y
Keycloak segaba la sesión a los 1800 s desde el último uso: **60 segundos de
margen**. Una laptop suspendida, un timer estrangulado en pestaña de fondo o un
parpadeo de red dentro de esa ventana mataban la sesión.

Corregido: token **900 s**, sesión ociosa **4 h**, tope **12 h**. Razonamiento
completo en [`../docs/security.md`](../docs/security.md#tiempos-de-sesión-valores-del-realm-en-segundos).

### Hueco 3 — El visor no decía nada · **CERRADO**

`OpenIdConnectRoutes.tsx` se suscribía **únicamente** a `addUserLoaded`. Ahora
cablea:

| Evento | Qué hace |
|---|---|
| `addAccessTokenExpiring` | nada visible (`console.debug`). Es la señal normal de renovación; está cableado para que quede escrito que es lo esperado |
| `addSilentRenewError` | **reintenta una vez a los 15 s**; si vuelve a fallar, aviso persistente con botón "Volver a entrar" |
| `addAccessTokenExpired` | mismo aviso persistente |
| `addUserLoaded` | fija el usuario **y retira el aviso** (la sesión se recuperó) |

El reintento no es adorno: la librería reintenta **solo** ante `ErrorTimeout` del
iframe (`SilentRenewService`, l. 2753), y nuestra vía es el refresh token — así
que un 5xx del token endpoint o un corte de red de dos segundos caían directo en
"sesión muerta" sin segunda oportunidad. Reintentar es seguro porque `expiring`
se emite 60 s antes del vencimiento: a los 15 s todavía queda token válido.

⚠️ **`addUserSignedOut` NO se cablea, y no es un olvido.** En `oidc-client-ts` v3
ese evento (y `addUserSignedIn` y `addUserSessionChanged`) solo se emite con
`monitorSession: true`, que es **`false` por defecto** (l. 2396) y que monta el
`check_session_iframe` del OP — o sea cookies de **terceros**, que es justo lo
que Chrome está matando. Encenderlo no daría el aviso: daría **cierres de sesión
espurios** cuando el navegador bloquee la cookie, que es peor que el silencio.
Detectar el cierre remoto pertenece al *back-channel logout*, no acá.

### Hueco 4 — AHI puede rechazar un token vigente · **CERRADO**

No estaba en el encargo original y es el que más veces nos ha mordido: un token
**válido y no vencido** puede recibir 403 de AHI por deriva de reloj en `iat`,
por `aud` que no coincide, o porque el authorizer apunta a otro issuer. Ese caso
**no emite ningún evento de `oidc-client-ts`**, así que el cableado de arriba no
lo cubre: el síntoma es imágenes rotas y nada en pantalla.

Ahora `httpErrorHandler` (en `genx-base.js`) reporta el fallo a la capa de
sesión, que decide el mensaje.

> ⚠️ **El código de estado NO dice el motivo. Verificado en runtime el
> 20-ago-2026.**
>
> La primera versión de este cableado asumía `401 = sesión` y `403 =
> configuración`. **Es falso en esta arquitectura**: quien rechaza es el
> **authorizer Lambda** de AHI, y una denegación de authorizer se traduce en
> **403**. O sea que el caso más común con diferencia —token vencido— llega
> como 403, no como 401.
>
> Cómo se vio: tras adelantar el reloj una hora, el visor dijo correctamente
> "Tu sesión caducó" (evento `addAccessTokenExpired`) y acto seguido, al navegar
> al home, anunció *"Tu sesión es válida pero el servidor no autorizó las
> imágenes"* — contradiciéndose a sí mismo.

La regla correcta, ya implementada: **preguntarle al token, no al status.** Ante
un 401 **o** un 403 se mira `user.expires_at` del usuario que tiene
`userAuthenticationService`:

- **Token vencido o ausente** → "Tu sesión caducó". Mismo título que el evento
  `addAccessTokenExpired` **a propósito**: la deduplicación del provider llavea
  por título+mensaje+tipo, así que la tormenta de frames fallidos se colapsa con
  el aviso que ya está en pantalla en vez de apilar otro que dice algo distinto.
- **Token vigente y aun así rechazado** → ahí sí es configuración (audiencia,
  reloj, permisos del datastore), y el mensaje lo dice sin mandar al usuario a
  reautenticarse en bucle.

⚠️ Ojo al mirar el usuario en memoria: `oidc-client-ts` **no lo borra** al
expirar (solo al cerrar sesión), así que "hay usuario" sigue siendo cierto con el
token muerto en la mano. Por eso la comprobación es sobre `expires_at`, no sobre
la existencia del objeto.

La costura es `window.genxSession`, publicada por `OpenIdConnectRoutes.tsx`
mientras está montado y retirada al desmontarse. Es fea a propósito y está
documentada en los dos lados: `app-config.js` es configuración plana que se carga
**antes** del bundle y no puede importar nada, así que `window` es la única
costura posible. Si el hook no está (arranque, o build sin OIDC), el config
degrada al `console.error` de siempre.

### Hueco 5 — El monitor de inactividad mataría el visor · **CERRADO**

Tampoco estaba en el encargo, y es una **regresión que la Fase 3 iba a
introducir**. `idle_session_monitor.dart` cerraba la sesión tras 15 min sin input
**en la ventana de la app**. Un radiólogo leyendo 20 minutos en el visor no toca
la app: desde ahí se ve idéntico a una estación abandonada.

Hoy eso es molesto (vuelve a entrar). Con sesión SSO compartida y logout global
se convertiría en *"me cerró el estudio a la mitad"*.

Ahora **bloquea** en vez de cerrar: 15 min → pantalla de bloqueo con la sesión
viva; 60 min bloqueada → cierre real con almacenamiento limpio. Detalle,
incluidas las dos trampas (persistir la marca para que un F5 no salte el candado;
el selector del provider que debe incluir `isLocked`), en
[`../docs/security.md`](../docs/security.md#almacenamiento-en-el-cliente).

---

### Hueco 6 — La sesión del visor era POR PESTAÑA · **CERRADO**

`oidc-client-ts` guarda al usuario en **`sessionStorage`** por defecto
(`UserManagerSettings`, l. 2433; el `stateStore` sí usa `localStorage`, l. 1018),
y `sessionStorage` es **por pestaña**. La app abre el visor con
`webOnlyWindowName: '_blank'` (`viewer_launcher.dart:79`), o sea una pestaña
nueva por estudio, cuyo `sessionStorage` para el origen de CloudFront nace vacío
— la copia desde el opener no aplica porque la app está en otro origen.

> ⚠️ **Corrección de una versión anterior de este documento.** Decía que eso
> significaba "formulario de login en cada estudio". **Es falso.** Rehacer el
> flujo OIDC no es lo mismo que ver un formulario: si Keycloak ya tiene su cookie
> de identidad —que la deja el primer login del visor—, el redirect a
> `/authorize` **vuelve solo**. El costo por pestaña era un round-trip, no un
> login.
>
> Lo que **sí** costaba un formulario era **cerrar el navegador**: con
> `rememberMe: false` en el realm, la cookie de identidad de Keycloak es una
> cookie **de sesión de navegador**, así que muere al cerrarlo. Y con el usuario
> en `sessionStorage`, no quedaba nada del lado del visor para recuperarse.

**Requisito del producto** (explícito, 19-ago-2026): si el radiólogo entra
después por su cuenta a `https://…/v4`, **no debería tener que hacer login**.

**Aplicado:** `userStore` a `localStorage` en `nextOIDCClient.ts`. La sesión se
comparte entre pestañas del mismo origen y sobrevive cerrar el navegador;
mientras la sesión SSO siga viva del lado de Keycloak (`ssoSessionIdleTimeout`,
4 h), la renovación por refresh token funciona sin pedir nada. Cero round-trip
por pestaña, además.

⚠️ **Es un intercambio deliberado y tiene una consecuencia que hay que conocer:**
quien se siente en esa estación y abra la URL del visor **entra como el último
usuario** hasta que la sesión expire, y el visor no tiene bloqueo por
inactividad (la app sí). Se aceptó porque la app de GenX ya persiste su propio
refresh token —que abre el API completo del RIS, o sea **más** permisos— en el
mismo navegador: negárselo al visor no protegía nada. Si el modelo de estación
compartida lo exige, lo que corresponde no es revertir esto sino **darle al visor
un "Salir"** (`/logout`, que ya existe) y el logout único de la Fase 3.

⚠️ Compartir el store entre pestañas es seguro **hoy** porque el realm tiene
`revokeRefreshToken: false`. Si se enciende la rotación de refresh tokens, dos
pestañas renovando a la vez pueden pisarse.

**Alternativa descartada:** `rememberMe` en el realm haría persistente la cookie
de Keycloak y lograría lo mismo sin tocar el visor — pero depende de que el
usuario marque una casilla en cada login, y tiene **exactamente la misma**
consecuencia de estación compartida. Más frágil por el mismo precio.

**Alternativa descartada:** nombre de ventana estable en vez de `_blank`.
Conservaría la sesión reutilizando la pestaña, pero **navega fuera del estudio
abierto** e impide comparar dos estudios lado a lado. Es un cambio de flujo
clínico para resolver un problema de sesión.

---

## 6. Plan por fases

El orden importa: cada fase reduce riesgo de la siguiente.

### ✅ Fase 0 — Tiempos de sesión + bloqueo por inactividad · HECHA

Cero código de auth nuevo. Se llevó el margen de renovación de 60 s a horas y
quitó el "me cierra la sesión mientras leo".

Los tres valores del realm viven en **dos** sitios y se mueven juntos: el realm
vivo (admin API) y `api/containers/keycloak/genx-realm.json`. Ese JSON **no** se
re-importa sobre un realm existente, así que editarlo no cambia nada en marcha —
es lo que hereda un bootstrap limpio.

> De paso: `genx-realm.json` **no contenía `genx-viewer`**. Un bootstrap limpio
> producía un realm sin el cliente del visor, y el visor fallaba en silencio. Ya
> está incluido en el export.

### ✅ Fase 1 — Eventos de sesión + 401/403 de AHI · HECHA

Independiente de todo lo demás. Quita el "no dice nada" **antes** de tocar el
login. Ver huecos 3 y 4.

Criterio de aceptación: con el token vencido a propósito, el visor **dice qué
pasó** y ofrece salida; no aparecen imágenes rotas sin explicación.

Se observó en runtime el 20-ago-2026 adelantando el reloj, y esa observación
**pagó por sí sola**: reveló que la regla `401 = sesión / 403 = configuración`
era falsa, porque quien deniega es el authorizer Lambda y eso siempre sale como
403. De ahí salió la regla correcta —preguntarle al token, no al status— que es
la que está implementada hoy. Republicado el 21-ago-2026. **Queda volver a
observarlo con la versión corregida.**

### ✅ Fase 2 — Keycloak con hostname público estable · HECHA (20/21-ago-2026)

Antes vivía en un túnel `trycloudflare` **efímero**: el hostname cambiaba solo en
cada reinicio. Con SSO por navegador ese hostname queda grabado en la sesión del
usuario, así que un túnel que se mueve deja a **todos** fuera. Y no era solo
estabilidad: el túnel existe porque **la Lambda authorizer de AHI necesita
alcanzar el JWKS desde internet**. No es un detalle de desarrollo, es parte del
camino de datos de producción.

**Lo que se hizo:** dominio propio `genx.mx` (registrado en Namecheap, zona
delegada a **Cloudflare**) y un túnel `cloudflared` **con nombre**
(`genx-keycloak`) publicando `auth.genx.mx` → `http://localhost:8180`. Corre como
**servicio de Windows**, así que sobrevive reinicios.

Se descartó montar Keycloak en AWS por ahora: el túnel con nombre quita el
problema real —que el issuer cambie solo— al costo de media hora. El destino
sigue siendo un dominio propio detrás de ALB/ACM cuando haya más de una clínica
en producción.

**El runbook completo vive en
[`../api/containers/keycloak/README.md`](../api/containers/keycloak/README.md)**
— cómo se montó, cómo se verifica que el JWKS es alcanzable *como lo ve la
Lambda*, y qué hacer cuando el visor empiece a fallar con lo que parece un error
de CORS. No está aquí a propósito: Keycloak lo usan los tres clientes del
sistema, no solo el visor.

Gracias al commit `971f54cf25` la URL vive en el **delta del cliente**, así que
moverla fue republicar (`scripts/publish-client.sh`), no recompilar. Pero se mueve
**en varios sitios a la vez** — ver §7.

⚠️ **Republicar no es opcional y el repo no te avisa.** El `authority` corregido
en `config/clients/mx-san-mungo.js` no llega al navegador hasta que corre
`publish-client.sh` **sin** `--dry-run`. Se perdió un rato persiguiendo un fallo
de autenticación con el repo ya correcto y CloudFront sirviendo el config viejo.
Comprobación de un solo comando, que mira lo que el usuario recibe y no lo que el
repo dice:

```bash
curl -s https://<dominio>/v4/app-config.js | grep -o "'https://[^']*realms/genx'"
```

### ⬜ Fase 3 — App de GenX a authorization code

**Solo web.** Existe `app/windows/` pero no hay build de Windows en uso, así que
no se adopta un paquete OIDC multiplataforma: code + PKCE contra Keycloak son
~200 líneas, cero dependencias nuevas, y el protocolo no cambia. Si algún día
entra Windows, el flujo es navegador del sistema + listener en loopback y ahí sí
convendrá un paquete.

**Crear un cliente público nuevo, p. ej. `genx-app`.** NO conviertas `genx-api` en
público ni le habilites `standardFlow`: es confidencial a propósito porque también
es el cliente servidor-a-servidor del backend, y debilitarlo para que sirva al
navegador degrada las dos cosas.

Lo que ayuda: Go valida **solo firma y `exp`** (`auth.go:109`) y Envoy valida
`iss` pero tiene `audiences` **comentado**. Un token emitido por `genx-app` pasa
las dos puertas **sin cambios de backend**.

> Ese mismo hecho es el hueco 🟠 de `../docs/security.md`. La versión limpia es
> barata y conviene hacerla en esta misma fase: un *audience mapper* en `genx-app`
> que ponga `aud: genx-api`, y descomentar `audiences` en `envoy.yaml`. Sin eso,
> cualquier token del realm —incluido el del visor— abre la API completa del RIS.

**`genx-app` NO va en `oidc_audiences` del authorizer de AHI.** La app no tiene
por qué poder leer píxeles directo; el visor sí.

Alcance en el front: la pantalla de login de Flutter pasa a ser un botón "entrar",
el RPC `Login` deja de ser el camino de credenciales, y refresh/logout se mueven a
la sesión del navegador. **`GatewayLogin` no se toca.**

#### ⚠️ Falta un RPC: sin `GetMySession` la fase no puede aterrizar

Esto no estaba en el encargo y **bloquea** la fase. `LoginResponse` no transporta
solo tokens: lleva también `User user = 5` y `repeated BranchOption branches = 6`
(`proto/user/user.proto:429-443`), y el front depende de las dos cosas
(`auth_notifier.dart:47-51`; de `branches` cuelga `activeBranchIdProvider`, o sea
el header `x-branch-id`, o sea **todo el RLS**).

Con code flow el token lo emite Keycloak **directamente al navegador**, así que
`Login` y `RefreshToken` dejan de correr — y con ellos desaparece el único
transporte de ese payload. No hay repuesto: en `user.proto` no existe ningún
`GetMe`/`GetCurrentUser`, y los únicos tres RPC que devuelven `LoginResponse` son
`Login`, `RefreshToken` y `GatewayLogin`.

**Pero el agujero real es más profundo que "faltan datos en pantalla".** Ese
mismo camino es el que mantiene vivo el espejo local de Keycloak:
`finishTokenExchange` (`user_service.go:1135-1184`) hace `syncUserFromKeycloak`,
el upsert en la tabla `users` — y recordá que **`users.id` ES el `sub` del JWT**,
no hay columna `keycloak_id`. Si nadie llama a ese camino, un usuario recién
creado en Keycloak autentica **perfectamente** (el `AuthInterceptor` solo mira
firma y `exp`, `auth.go:109`) y **no tiene fila en `users`**. Lo que se ve
entonces:

- `BranchInterceptor` → `ListBranchesForUser` arranca con `FROM users u WHERE
  u.id = $1` → cero sucursales → **`PermissionDenied`** … y el resultado vacío
  queda **cacheado 5 minutos** (`branch_access_cache.go:19`).
- `UpdateMyPreferences` revienta por FK contra `users(id)`.

O sea: un fallo de *identidad* que se reporta como *permiso denegado*, y que
además persiste 5 min después de arreglarlo. Exactamente el modo de fallo que
`docs/security.md` §6 marca como el más caro de diagnosticar.

**La forma del arreglo.** Un RPC nuevo `GetMySession` (sin `user_id` en el
request — el patrón de `GetMyPreferences`, `user_preference_handler.go:104-115`)
que devuelva `User` + `branches`, y que **haga el upsert**. Casi todo el código ya
existe: `finishTokenExchange` son seis pasos y solo el primero
(`GetUserInfo`, l. 1136) sobra, porque el `sub` ya viene del JWT validado en el
`ctx`. Se extraen los pasos 2-6 a un `buildSessionForSub(ctx, sub)` y lo comparten
`finishTokenExchange` y `GetMySession`. Cero SQL nuevo.

De regalo, un costo que desaparece: hoy **el refresh cuesta lo mismo que el
login** (4 saltos a Keycloak + la query de sucursales, cada 15 min por cliente —
`security.md` §7). Con code flow el refresh ocurre en el navegador contra
Keycloak, así que ese RPC deja de existir para la app web y el espejo se
sincroniza **una vez por sesión** en vez de en cada renovación.

Tres cosas más que hay que resolver dentro de esta fase y no después:

1. **El "Salir" debe cerrar de verdad.** Hoy `AuthNotifier.logout()` solo borra
   el almacenamiento local; el refresh token que quedó fuera sigue siendo
   canjeable durante las 4 h de sesión ociosa. Con code flow esto se convierte en
   un redirect al `end_session_endpoint`, que además cierra la del visor. En una
   estación compartida de radiología esto no es cosmético.
2. **Desbloquear** deja de ser un `login` con contraseña contra el backend
   (`auth_notifier.dart:185`, que hoy rehace un ROPC completo). La contraseña la
   vuelve a pedir Keycloak, y la sesión del visor **no se entera** — que es
   exactamente lo que hace que el radiólogo pueda leer sin interrupciones con la
   estación protegida.

   ⚠️ **Decidido: popup, no `signinRedirect`.** Una versión anterior de esta
   sección proponía `signinRedirect({ prompt: 'login' })`. Es más simple de
   escribir, pero navega fuera de la SPA: al volver, Flutter web **recarga desde
   cero** y se pierde todo lo que estuviera a medio llenar — una orden de
   servicio, un informe sin guardar. Una pantalla de *bloqueo* que cuesta lo
   mismo que salir y entrar no es una pantalla de bloqueo. Va por ventana
   emergente (`window.open` + `postMessage` desde la página de callback), con la
   app viva en memoria detrás.

3. **Las exenciones de JWT quedan huérfanas y hay que retirarlas.** `Login` y
   `RefreshToken` están exentos de validación en **dos** listas que hay que mover
   juntas: `publicMethods` en `auth.go:42-54` y las `rules` de `jwt_authn` en
   `envoy.yaml:122-125`. Cuando la app deje de usarlos, dejarlos abiertos es
   superficie de ataque sin contrapartida. Y al revés: **`GetMySession` NO va en
   esas listas** — necesita el JWT, que es justamente de donde saca de quién es
   la sesión.

---

## 7. Trampas ya verificadas

- **El `issuer` se mueve en VARIOS sitios a la vez**: el delta del cliente del
  visor, `infra/viewer/terraform.tfvars` (`oidc_issuer`),
  `api/containers/envoy/envoy.yaml` y `KC_HOSTNAME` del docker-compose de
  Keycloak. Con la Fase 3 se suma la config OIDC de la app. Si se separan, el
  visor autentica pero **AHI devuelve 403 en cada frame** y el CloudWatch del
  authorizer sale **vacío** — despista muchísimo. Ya nos pasó.
- **Idéntico carácter a carácter** al claim `iss`. Ni barra final de más, ni `http`
  donde el token dice `https`: `oidc-client-ts` compara la cadena.
- **Mover el `issuer` le cuesta un login a TODOS los usuarios.** No es un bug ni
  una regresión, pero sorprende y hace pensar que algo se rompió. Se resetean
  **dos** capas a la vez, las dos pegadas al hostname viejo:

  1. `oidc-client-ts` llavea al usuario guardado por *authority* —
     `` `user:${authority}:${client_id}` `` (`oidc-client-ts.js:3509`) — así que
     la entrada de `localStorage` queda **huérfana**: sigue ahí, pero el visor ya
     busca otra llave y nunca la encuentra.
  2. La cookie SSO de Keycloak (`KEYCLOAK_IDENTITY`) está **pegada al host**. El
     host nuevo no la recibe, así que Keycloak legítimamente no reconoce ese
     navegador.

  O sea que el hueco 6 (sesión persistente) sigue funcionando: lo que caducó fue
  la dirección donde vivía. Es un costo de **una sola vez** por mudanza, y hay
  que volver a pagarlo el día que se monte el dominio propio detrás de ALB/ACM.
- **Un túnel caído se ve como un error de CORS.** Si `cloudflared` no está
  corriendo, Cloudflare responde **HTTP 530 / `error code: 1033`**, y como esa
  página de error no lleva `Access-Control-Allow-Origin`, la consola del
  navegador reporta *"blocked by CORS policy"* sobre el
  `.well-known/openid-configuration`. **No toques `webOrigins`**: ya está bien.
  Antes de creerle a la consola, `curl` el endpoint y mira el **status**. Detalle
  y arreglo en el runbook de Keycloak.
- **Los redirect URIs de `genx-viewer` listan el dominio de CloudFront.** Cuando se
  agregue el dominio propio del cliente hay que añadirlo ahí **y** en `webOrigins`,
  o el login falla después del deploy, no durante.
- **Popup blocker**: el visor se abre en pestaña nueva (`launchUrl` con
  `webOnlyWindowName: '_blank'`). Ver `docs/viewers.md`. Nota para §9: eso
  significa que la app **no conserva el handle de la ventana**, así que el puente
  por `postMessage` ni siquiera está disponible hoy sin cambiar el lanzamiento.
- **`routerBasename` sin barra final** — ya documentado extensamente en
  `genx-base.js`; con `/v4/` el callback entra en bucle.
- **AHI exige `aud`/`azp` y tolera CERO deriva en `iat`.** Un segundo de reloj
  adelantado = 403 que parece problema de permisos.
- **`app-config.js` corre antes que el bundle y no puede importar.** Por eso el
  puente de los 401/403 es `window.genxSession`. El gate de `publish-client.sh`
  ejecuta el config con `global.window = {}`, así que la referencia debe quedar
  **dentro** del cuerpo de `httpErrorHandler`, nunca en el nivel superior.

---

## 8. Cómo probarlo

- **Keycloak local**: `http://127.0.0.1:8180`, realm `genx`. El token de admin sale
  con `client_id=admin-cli` + `grant_type=password` contra el realm `master`; con
  él, `GET /admin/realms/genx/clients` da la config de los clientes y
  `GET /admin/realms/genx` las vidas de sesión.
- **Confirmar que la renovación va por refresh token** (cierra la última duda de
  §10): con el visor abierto, DevTools → **Network**. Los botones de esa barra
  (`Fetch/XHR`, `Doc`, `CSS`, `JS`, `Img`…) son **tipos de recurso**, no hay uno
  de "token": lo que hay que usar es la **caja de texto de filtro** (la de
  `Filter`, a la izquierda de esos botones) y escribir `token`. Alternativa:
  pulsar `Fetch/XHR` y buscar la petición a mano.

  A los ~14 min debe salir **un POST a `/protocol/openid-connect/token`** cuyo
  *payload* lleve `grant_type=refresh_token`, y **ningún** GET a
  `/authorize?prompt=none`. Si aparece el GET, la renovación está yendo por
  iframe y sí depende de cookies de terceros — ver §5, hueco 2.

- **Probar el aviso de sesión — adelantando el reloj.** Es el único método que
  se comprobó que funciona. Adelantar el reloj de la máquina **más de 15 min**
  (la vida del access token) y forzar una petición de imágenes: cambiar de serie,
  o hacer scroll a un frame no cargado. Debe aparecer el aviso persistente **"Tu
  sesión caducó"** con botón "Volver a entrar", y seguir diciendo lo mismo al
  navegar por la app — **no** imágenes rotas, y **no** un segundo aviso que
  afirme algo distinto.

  ⚠️ **Devolver el reloj al terminar**, y comprobarlo. Con la máquina adelantada:
  el **AWS CLI deja de funcionar** (`RequestTimeTooSkewed`, tolerancia 15 min),
  así que `publish-client.sh` aborta a mitad; y **AHI tolera CERO deriva en
  `iat`**, así que cualquier prueba posterior de imágenes da 403 por el reloj y
  no por lo que se esté probando. Las dos veces el error apunta a otro sitio.

      w32tm /resync        # Windows, requiere consola de administrador

- **⚠️ Borrar `oidc.user:…` NO prueba lo que parece.** Una versión anterior de
  esta sección lo proponía; se comprobó que **no invalida nada** y el visor sigue
  funcionando, que es el comportamiento correcto:

  1. OHIF guarda el usuario también **en memoria** (`userAuthenticationService`,
     estado de React), y `getAuthorizationHeader()` lee de ahí — no del store.
     Borrar el almacenamiento no toca el token que ya está en uso.
  2. Al recargar la página sí se pierde la copia en memoria, pero entonces
     `PrivateRoute` llama a `handleUnauthenticated()` → `signinRedirect()`, y
     Keycloak reconoce su cookie y **devuelve el código sin formulario**. El
     usuario no ve nada.

  O sea que esa prueba mide el **camino de recuperación**, no la sesión caída — y
  que pase limpiamente es una buena noticia: es el SSO funcionando. La entrada,
  por cierto, hoy vive en **Local Storage** (ver hueco 6), no en Session Storage.
- **Publicar el visor** tras cambiar el delta: `scripts/publish-client.sh
  mx-san-mungo v4 genx-viewer E2LJQSZZKKATFJ`. Correr antes con `--dry-run`: valida
  el delta ejecutándolo de verdad.
- El `authority` está en el delta, así que **cambiar Keycloak no exige recompilar**
  — pero la Fase 1 sí cambió código del visor, así que esa **sí** exige
  recompilar y republicar.

---

## 9. Lo que NO hacer

### El atajo del `?token=`

OHIF trae de fábrica un camino que **funciona hoy**:
`Mode.tsx:71` lee `?token=` de la URL y `updateAuthServiceAndCleanUrl.ts` fija
`Authorization: Bearer <token>` para todas las peticiones, limpiando después la URL
con `replaceState`.

Y es peor-que-tentador porque **ya encajaría sin tocar Keycloak**: el authorizer de
AHI acepta `azp` o `aud`, `oidc_audiences` incluye `genx-api`, y el backend firma
con `genx-api` — o sea el `access_token` que la app ya tiene **pasaría el filtro de
AHI tal cual**. `ResolveViewerLaunch` ya arma la URL server-side; sería una línea.

**No lo conviertas en la arquitectura**, por dos razones concretas:

1. **No hay renovación.** `getAuthorizationHeader` devolvería un closure sobre un
   string fijo. A los 900 s el visor empieza a comerse 403 con el estudio abierto,
   y no tiene forma de renovar porque nunca tuvo sesión. (El token es **más
   corto** desde la Fase 0, así que este atajo envejeció peor todavía.)
2. **El token va en la query string**, o sea a los access logs de CloudFront. El
   `replaceState` limpia la barra de direcciones **después** de que la petición ya
   viajó. Es una credencial de lectura sobre PHI.

Si por presión de calendario hace falta un puente temporal, que sea explícito,
con fecha de retirada, y **entregado por `postMessage`** — nunca por query string.
Ojo: eso exige que la app conserve el handle de la ventana, y hoy `launchUrl` no
lo devuelve, así que ni siquiera es el atajo barato que parece. El destino sigue
siendo la §4.

### Otras

- **No debilites `genx-api`** para que haga code flow. Cliente nuevo.
- **No compartas el token de la app con el visor** en la arquitectura final. Cada
  app tiene el suyo; es lo que hace que ninguna dependa de la otra.
- **No enciendas `monitorSession`** para conseguir `addUserSignedOut`. Ver §5,
  hueco 3.

---

## 10. Lo que NO se verificó

Honestidad sobre los límites de este diagnóstico:

- **Que la Fase 1 YA CORREGIDA se comporte en runtime.** El aviso sí se vio en
  pantalla el 20-ago-2026 con el reloj adelantado, y de ahí salió la corrección
  del hueco 4. Lo que no se ha vuelto a observar es el comportamiento **después**
  de esa corrección: que un 403 con token vigente y uno con token vencido digan
  cosas distintas, y que el vencido se deduplique contra el aviso de
  `addAccessTokenExpired` en vez de apilar un segundo mensaje. Procedimiento
  en §8.
- **Que la renovación real sea un `grant_type=refresh_token`.** Está deducido del
  código de la librería y de la config de Keycloak, que es evidencia fuerte, pero
  no se miró una renovación viva en Network. §8 dice cómo.
- **Si el single logout está cableado** de punta a punta. El visor declara
  `post_logout_redirect_uri` y `revokeAccessTokenOnSignout`, pero no se probó que
  cerrar sesión en la app cierre la del visor — y hoy no puede, porque el logout
  de la app ni siquiera habla con Keycloak.
- **Que v3 sea alternativa.** No lo es para color — ver
  [`GENX-DICOMWEB.md`](GENX-DICOMWEB.md) y la nota del verde en HTJ2K.
