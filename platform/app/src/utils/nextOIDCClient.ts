import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

/**
 * Creates a userManager from oidcSettings
 * LINK: https://github.com/IdentityModel/oidc-client-js/wiki#configuration
 *
 * @param {Object} oidcSettings
 * @param {string} oidcSettings.authServerUrl,
 * @param {string} oidcSettings.clientId,
 * @param {string} oidcSettings.authRedirectUri,
 * @param {string} oidcSettings.postLogoutRedirectUri,
 * @param {string} oidcSettings.responseType,
 * @param {string} oidcSettings.extraQueryParams,
 */
export default function getUserManagerForOpenIdConnectClient(oidcSettings) {
  if (!oidcSettings) {
    return;
  }

  if (!oidcSettings.authority || !oidcSettings.client_id || !oidcSettings.redirect_uri) {
    console.error('Missing required oidc settings:  authority, client_id, redirect_uri');
    return;
  }

  const settings = {
    ...oidcSettings,
    // The next client always use the code flow with PKCE
    response_type: 'code',
    revokeTokensOnSignout: oidcSettings.revokeAccessTokenOnSignout ?? true,
    filterProtocolClaims: true,
    // the followings are default values in the lib so no need to set them
    // automaticSilentRenew: true,

    // [genx] La sesión del visor vive en localStorage, no en sessionStorage.
    //
    // El default de oidc-client-ts para `userStore` es `sessionStorage`, que es
    // POR PESTAÑA: cada pestaña nueva del visor nace sin sesión y tiene que
    // rehacer el flujo OIDC, y al cerrar el navegador se pierde del todo.
    // Como la app abre el visor con `_blank` (una pestaña nueva por estudio) y
    // el radiólogo también entra por la URL directa, eso significaba un
    // round-trip a Keycloak por pestaña y un formulario después de cada cierre
    // de navegador.
    //
    // Con localStorage el token se comparte entre pestañas del mismo origen y
    // sobrevive cerrar el navegador; mientras la sesión SSO siga viva del lado
    // de Keycloak (`ssoSessionIdleTimeout`, hoy 4 h), la renovación por refresh
    // token funciona sin pedir nada.
    //
    // ⚠️ Es un intercambio DELIBERADO, no un default heredado: el token de
    // lectura de imágenes queda legible por JS y persiste en la máquina. Se
    // aceptó porque la app de GenX ya persiste su propio refresh token —que
    // abre el API completo del RIS, o sea MÁS permisos— en el mismo navegador,
    // así que negárselo al visor no protegía nada. La contrapartida es que
    // quien se siente en esa estación y abra la URL del visor entra como el
    // último usuario hasta que la sesión expire.
    //
    // ⚠️ Compartir el store entre pestañas es seguro HOY porque el realm tiene
    // `revokeRefreshToken: false` (reusar un refresh token es válido). Si algún
    // día se enciende la rotación de refresh tokens, dos pestañas renovando a
    // la vez pueden pisarse. Ver viewer/GENX-AUTH.md, hueco 6.
    //
    // `stateStore` se deja en su default (localStorage): lo necesita el
    // redirect del code flow, que vuelve en una carga de página nueva.
    userStore: new WebStorageStateStore({ store: window.localStorage }),
  };

  const userManager = new UserManager(settings);

  return userManager;
}
