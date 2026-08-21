// Delta de cliente: San Mungo (slug `mx-san-mungo`).
//
// Se concatena DESPUÉS de genx-base.js para formar el app-config.js que se
// publica en el sitio de este cliente. Solo va aquí lo que difiere del base.
//
// El datastore ya NO es un campo suelto: viaja dentro de las tres raíces de
// DICOMweb. Ese es justamente el aislamiento entre clientes — el bundle
// publicado para uno no contiene la URL de ningún otro.
//
// OJO: este es el datastore con OIDC (`lambdaAuthorizerArn`), NO el legacy
// 233cd98b... que sirve el proxy. Los dos conviven; ver
// infra/modules/ahi-oidc-authorizer/README.md.
//
//   cd infra/viewer && tofu output ahi_datastore_role_map

// La raíz es RELATIVA, y eso NO es cosmético: es lo que hace que los requests
// de DICOMweb salgan al mismo dominio que sirve el visor, donde CloudFront tiene
// un behavior /datastore/* que los manda a AHI (infra/modules/viewer-site).
//
// Con la URL absoluta de AHI el navegador cruza a otro origen: pierde el
// multiplexado HTTP/2, paga el RTT completo clínica->us-east-1 en cada conexión
// y suma un preflight CORS POR CADA URL DE FRAME — un GET con header
// `Authorization` no es una petición simple, y la caché de preflight se llavea
// por URL. Eso deshace la fase que llevó el end-to-end de 13.2 s a 5.6 s.
//
// No reintroduce el proxy Lambda: AHI sigue autorizando con el authorizer OIDC
// y sirviendo los frames él mismo. Solo cambia por dónde viajan.
//
// Funciona sin reescritura de path porque las URLs de DICOMweb de AHI ya
// empiezan con /datastore/, igual que el path pattern del behavior.
//
// Contexto completo: viewer/GENX-DICOMWEB.md
(function () {
  var root = '/datastore/c107f00dbca2487b9b98235ba84f428a';

  Object.assign(window.config.dataSources[0].configuration, {
    // Las tres apuntan al mismo sitio: AHI expone QIDO y WADO bajo la misma
    // raíz. `wadoUriRoot` es WADO-URI (el protocolo viejo) y AHI no lo
    // implementa, pero OHIF lo exige presente en el config.
    qidoRoot: root,
    wadoRoot: root,
    wadoUriRoot: root,
  });
})();

// Keycloak de ESTE entorno. Vive en el delta y no en el base porque es lo
// único que cambia entre QA y producción: con el mismo build publicado dos
// veces, cada sitio apunta a su propio realm.
//
// Las dos reglas al moverla:
//
//   1. Tiene que ser IDÉNTICA al claim `iss` que emite Keycloak. Ni barra
//      final de más, ni http donde el token dice https — `oidc-client-ts`
//      compara la cadena y falla con "Invalid issuer in token response".
//   2. El mismo valor va en `oidc_issuer` de infra/viewer/terraform.tfvars.
//      El authorizer de AHI deriva de ahí su JWKS
//      ({issuer}/protocol/openid-connect/certs, index.js:20), así que si los
//      dos se separan el visor autentica pero AHI devuelve 403 en cada frame
//      — y el CloudWatch del authorizer sale VACÍO, que despista mucho.
//
// El navegador solo necesita esta cadena: el resto (authorize, token, JWKS) lo
// descubre pidiendo {authority}/.well-known/openid-configuration.
window.config.oidc[0].authority = 'https://auth.genx.mx/realms/genx';

// El título va horneado en index.html en tiempo de build, así que para que sea
// por cliente hay que pisarlo aquí (esto corre antes de que monte React).
document.title = 'San Mungo — Visor';
