import React from 'react';
import { useEffect, useMemo } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import CallbackPage from '../routes/CallbackPage';
import SignoutCallbackComponent from '../routes/SignoutCallbackComponent';
import LegacyClient from './legacyOIDCClient';
import NextClient from './nextOIDCClient';

function _isAbsoluteUrl(url) {
  return url.includes('http://') || url.includes('https://');
}

function _makeAbsoluteIfNecessary(url, base_url) {
  if (_isAbsoluteUrl(url)) {
    return url;
  }

  /*
   * Make sure base_url and url are not duplicating slashes.
   */
  if (base_url[base_url.length - 1] === '/') {
    base_url = base_url.slice(0, base_url.length - 1);
  }

  return base_url + url;
}

const initUserManager = (oidc, routerBasename) => {
  if (!oidc || !oidc.length) {
    return;
  }

  const firstOpenIdClient = oidc[0];
  const { protocol, host } = window.location;
  const baseUri = `${protocol}//${host}${routerBasename}`;

  const redirect_uri = firstOpenIdClient.redirect_uri || '/callback';
  const silent_redirect_uri = firstOpenIdClient.silent_redirect_uri || '/silent-refresh.html';
  const post_logout_redirect_uri = firstOpenIdClient.post_logout_redirect_uri || '/';

  const openIdConnectConfiguration = Object.assign({}, firstOpenIdClient, {
    redirect_uri: _makeAbsoluteIfNecessary(redirect_uri, baseUri),
    silent_redirect_uri: _makeAbsoluteIfNecessary(silent_redirect_uri, baseUri),
    post_logout_redirect_uri: _makeAbsoluteIfNecessary(post_logout_redirect_uri, baseUri),
  });

  const client = firstOpenIdClient.response_type === 'code' ? NextClient : LegacyClient;

  return client(openIdConnectConfiguration);
};

function LogoutComponent(props) {
  const { userManager } = props;
  localStorage.setItem('signoutEvent', 'true');
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  userManager.signoutRedirect({
    post_logout_redirect_uri: query.get('redirect_uri'),
  });
  return null;
}

function LoginComponent(userManager) {
  const queryParams = new URLSearchParams(location.search);
  const iss = queryParams.get('iss');
  const loginHint = queryParams.get('login_hint');
  const targetLinkUri = queryParams.get('target_link_uri');
  if (iss !== oidcAuthority) {
    console.error('iss of /login does not match the oidc authority');
    return null;
  }

  userManager.removeUser().then(() => {
    if (targetLinkUri !== null) {
      const ohifRedirectTo = {
        pathname: new URL(targetLinkUri).pathname,
      };
      sessionStorage.setItem('ohif-redirect-to', JSON.stringify(ohifRedirectTo));
    } else {
      const ohifRedirectTo = {
        pathname: '/',
      };
      sessionStorage.setItem('ohif-redirect-to', JSON.stringify(ohifRedirectTo));
    }

    if (loginHint !== null) {
      userManager.signinRedirect({ login_hint: loginHint });
    } else {
      userManager.signinRedirect();
    }
  });

  return null;
}

function OpenIdConnectRoutes({
  oidc,
  routerBasename,
  userAuthenticationService,
  uiNotificationService,
}) {
  const userManager = useMemo(() => initUserManager(oidc, routerBasename), [oidc, routerBasename]);

  const getAuthorizationHeader = () => {
    const user = userAuthenticationService.getUser();

    // if the user is null return early, next time
    // we hit this function we will have a user
    if (!user) {
      return;
    }

    return {
      Authorization: `Bearer ${user.access_token}`,
    };
  };

  const handleUnauthenticated = () => {
    // Note: Don't await the redirect. If you make this component async it
    // causes a react error before redirect as it returns a promise of a component rather than a component.
    userManager.signinRedirect();

    // return null because this is used in a react component
    return null;
  };

  const navigate = useNavigate();

  //for multi-tab logout
  useEffect(() => {
    localStorage.removeItem('signoutEvent');
    const storageEventListener = event => {
      const signOutEvent = localStorage.getItem('signoutEvent');
      if (signOutEvent) {
        navigate(`/logout?redirect_uri=${encodeURIComponent(window.location.href)}`);
      }
    };

    window.addEventListener('storage', storageEventListener);

    return () => {
      window.removeEventListener('storage', storageEventListener);
    };
  }, []);

  useEffect(() => {
    userAuthenticationService.set({ enabled: true });

    userAuthenticationService.setServiceImplementation({
      getAuthorizationHeader,
      handleUnauthenticated,
    });
  }, []);

  // ── [genx] Ciclo de vida de la sesión ─────────────────────────────────────
  //
  // Antes acá solo se escuchaba `addUserLoaded`, así que la muerte de la sesión
  // se manifestaba como imágenes rotas y 403 en consola: nada en pantalla. Este
  // efecto cubre los tres eventos que sí importan y el rechazo del servidor de
  // imágenes, que es el único síntoma que aparece cuando el token es
  // sintácticamente válido pero AHI lo rechaza igual.
  //
  // NO se escucha `addUserSignedOut` (ni los otros dos de sesión): en
  // oidc-client-ts v3 esos eventos solo se emiten con `monitorSession: true`,
  // que monta el `check_session_iframe` del OP y por lo tanto necesita cookies
  // de TERCEROS — el visor vive en CloudFront y Keycloak en otro dominio.
  // Encenderlo no daría el aviso: daría cierres de sesión espurios cuando el
  // navegador bloquee la cookie. Detectar el cierre remoto pertenece al
  // back-channel logout, no acá.
  useEffect(() => {
    if (!userManager) {
      return;
    }

    // Un solo aviso reutilizado. Una sesión caída falla UNA VEZ POR FRAME: sin
    // id fijo y sin dedup larga, el radiólogo vería decenas de avisos idénticos.
    const SESSION_TOAST_ID = 'genx-session';
    const DEDUP_MS = 10 * 60 * 1000;

    let retryTimer = null;
    let retried = false;

    const showSessionProblem = (title, message) => {
      uiNotificationService?.show({
        id: SESSION_TOAST_ID,
        title,
        message,
        type: 'error',
        // `autoClose` no llega al toast: el provider solo reenvía `duration`.
        // Infinity es la convención de sonner para "no se cierra solo".
        duration: Infinity,
        position: 'top-center',
        allowDuplicates: false,
        deduplicationInterval: DEDUP_MS,
        action: {
          label: 'Volver a entrar',
          // El cuerpo del componente ya dejó la ruta actual en
          // `ohif-redirect-to` (relativa al routerBasename), así que el callback
          // devuelve al MISMO estudio. No usar `window.location.pathname` acá:
          // lleva el basename y react-router se lo volvería a anteponer.
          onClick: () => userManager.signinRedirect(),
        },
      });
    };

    const userLoadedHandler = user => {
      userAuthenticationService.setUser(user);
      // Token nuevo en mano: retirar el aviso y rearmar el reintento.
      retried = false;
      uiNotificationService?.hide(SESSION_TOAST_ID);
    };

    // Señal NORMAL: falta ~1 min y `automaticSilentRenew` ya está renovando.
    // No se muestra nada. Está cableado para que quede escrito que este evento
    // es lo esperado y nadie lo confunda con un problema.
    const tokenExpiringHandler = () => {
      console.debug('[genx] access token por expirar; renovación en curso');
    };

    const silentRenewErrorHandler = error => {
      console.warn('[genx] falló la renovación silenciosa', error);

      if (!retried) {
        // Un parpadeo de red no debería costar la sesión. oidc-client-ts
        // reintenta SOLO ante `ErrorTimeout` del iframe (SilentRenewService:
        // `_retryTimer.init(5)`); nuestra renovación va por refresh token, así
        // que un fallo de red o un 5xx del token endpoint cae directo en este
        // evento y la librería NO vuelve a intentar — el evento `expiring` que
        // dispara la renovación ya pasó y no se repite.
        //
        // Reintentar es seguro: `expiring` se emite 60 s antes del vencimiento,
        // así que a los 15 s todavía queda token válido.
        retried = true;
        retryTimer = setTimeout(() => {
          userManager.signinSilent().catch(err => {
            console.warn('[genx] el reintento de renovación también falló', err);
            showSessionProblem(
              'Tu sesión no pudo renovarse',
              'Vuelve a entrar para seguir viendo el estudio. No se perdió nada: el estudio se reabre solo.'
            );
          });
        }, 15000);
        return;
      }

      showSessionProblem(
        'Tu sesión no pudo renovarse',
        'Vuelve a entrar para seguir viendo el estudio. No se perdió nada: el estudio se reabre solo.'
      );
    };

    // El token venció de verdad. oidc-client-ts NO borra al usuario acá (solo
    // lo hace al cerrar sesión), así que `getAuthorizationHeader` seguiría
    // mandando el token muerto: sin este aviso, el síntoma es 403 en cada frame.
    const tokenExpiredHandler = () => {
      showSessionProblem('Tu sesión caducó', 'Vuelve a entrar para seguir viendo el estudio.');
    };

    userManager.events.addUserLoaded(userLoadedHandler);
    userManager.events.addAccessTokenExpiring(tokenExpiringHandler);
    userManager.events.addAccessTokenExpired(tokenExpiredHandler);
    userManager.events.addSilentRenewError(silentRenewErrorHandler);

    // Puente para `httpErrorHandler` de app-config.js.
    //
    // Ese archivo es configuración plana que se carga ANTES del bundle: no
    // puede importar nada, así que `window` es la única costura posible. Es un
    // contrato con nombre y con limpieza, no un global suelto — y si no está
    // (antes de que monte React), el config solo loguea, como hacía antes.
    //
    // Vale la pena porque un token puede estar vigente y AHI rechazarlo igual:
    // deriva de reloj en `iat`, `aud` que no coincide, authorizer mal apuntado.
    // Ese caso NO produce ningún evento de oidc-client-ts.
    // ¿La credencial que tenemos en mano sigue sirviendo?
    //
    // Lo que importa NO es que exista un usuario, sino que su token no haya
    // vencido: `userAuthenticationService` conserva el usuario en memoria (React
    // state, sin serializar) y oidc-client-ts no lo borra al expirar, así que
    // "hay usuario" sigue siendo cierto con el token muerto en la mano.
    const sessionLooksAlive = () => {
      const user = userAuthenticationService.getUser();
      if (!user) {
        return false;
      }
      // `expires_at` es epoch en SEGUNDOS y sobrevive cualquier serialización;
      // el getter `expired` solo existe en la instancia viva de `User`.
      if (typeof user.expires_at === 'number') {
        return user.expires_at * 1000 > Date.now();
      }
      if (typeof user.expired === 'boolean') {
        return !user.expired;
      }
      // Sin forma de saberlo: no afirmar que caducó.
      return true;
    };

    window.genxSession = {
      reportHttpError: error => {
        const status = error?.status ?? error?.request?.status ?? error?.response?.status;
        if (status !== 401 && status !== 403) {
          return;
        }

        // ⚠️ NO se puede deducir el motivo del código de estado. En esta
        // arquitectura quien rechaza es el authorizer Lambda de AHI, y una
        // denegación de authorizer se traduce en **403**, no en 401 — así que
        // un token vencido, que es el caso más común con diferencia, llega
        // como 403. Verificado en runtime el 20-ago-2026: tras adelantar el
        // reloj, AHI devolvió 403 y la versión anterior de este código
        // anunciaba "tu sesión es válida" justo después de que el visor
        // acabara de decir que había caducado.
        //
        // Por eso la pregunta se le hace al TOKEN, no al status.
        if (!sessionLooksAlive()) {
          // Mismo título que `tokenExpiredHandler` a propósito: la deduplicación
          // del provider llavea por título+mensaje+tipo, así que la tormenta de
          // frames fallidos se colapsa con el aviso que ya está en pantalla en
          // vez de apilar un segundo aviso que dice otra cosa.
          showSessionProblem('Tu sesión caducó', 'Vuelve a entrar para seguir viendo el estudio.');
          return;
        }

        // Token vigente y aun así rechazado: esto NO es la sesión. Es
        // configuración —`aud` que no coincide, deriva de reloj en `iat`,
        // permisos del datastore, authorizer apuntando a otro issuer— y mandar
        // al usuario a reautenticarse en bucle sería peor que decirle la verdad.
        showSessionProblem(
          'El servidor de imágenes denegó el acceso',
          'Tu sesión sigue vigente pero el servidor no autorizó las imágenes. Si vuelve a pasar después de reentrar, avisa a soporte.'
        );
      },
    };

    // Cleanup on component unmount.
    return () => {
      clearTimeout(retryTimer);
      userManager.events.removeUserLoaded(userLoadedHandler);
      userManager.events.removeAccessTokenExpiring(tokenExpiringHandler);
      userManager.events.removeAccessTokenExpired(tokenExpiredHandler);
      userManager.events.removeSilentRenewError(silentRenewErrorHandler);
      if (window.genxSession) {
        delete window.genxSession;
      }
    };
  }, []);

  const oidcAuthority = oidc[0].authority;

  const location = useLocation();
  const { pathname, search } = location;

  const redirectURI = userManager.settings._redirect_uri ?? userManager.settings.redirect_uri;
  const silentRedirectURI =
    userManager.settings._silent_redirect_uri ?? userManager.settings.silent_redirect_uri;
  const postLogoutRedirectURI =
    userManager.settings._post_logout_redirect_uri ?? userManager.settings.post_logout_redirect_uri;

  const redirect_uri = new URL(redirectURI).pathname.replace(
    routerBasename !== '/' ? routerBasename : '',
    ''
  );
  const silent_refresh_uri = new URL(silentRedirectURI).pathname; //.replace(routerBasename,'')
  const post_logout_redirect_uri = new URL(postLogoutRedirectURI).pathname; //.replace(routerBasename,'');

  // const pathnameRelative = pathname.replace(routerBasename,'');

  if (pathname !== redirect_uri) {
    sessionStorage.setItem('ohif-redirect-to', JSON.stringify({ pathname, search }));
  }

  return (
    <Routes>
      <Route
        path={silent_refresh_uri}
        onEnter={window.location.reload}
      />
      <Route
        path={post_logout_redirect_uri}
        element={
          <SignoutCallbackComponent
            userManager={userManager}
            successCallback={() => console.log('Signout successful')}
            errorCallback={error => {
              console.warn(error);
              console.warn('Signout failed');
            }}
          />
        }
      />
      <Route
        path={redirect_uri}
        element={
          <CallbackPage
            userManager={userManager}
            onRedirectSuccess={user => {
              const { pathname, search = '' } = JSON.parse(
                sessionStorage.getItem('ohif-redirect-to')
              );

              userAuthenticationService.setUser(user);

              navigate({
                pathname,
                search,
              });
            }}
          />
        }
      />
      <Route
        path="/login"
        element={
          <LoginComponent
            userManager={userManager}
            oidcAuthority={oidcAuthority}
          />
        }
      />
      <Route
        path="/logout"
        element={<LogoutComponent userManager={userManager} />}
      />
    </Routes>
  );
}

export default OpenIdConnectRoutes;
