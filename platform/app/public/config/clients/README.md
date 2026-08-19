# Deltas de configuración por cliente

Un archivo por cliente, nombrado con su **slug** (`{país}-{nombre}`, el mismo de
`infra/hospitals/`). `scripts/publish-client.sh` lo concatena después de
`../genx-base.js` para producir el `app-config.js` de ese cliente:

```
app-config.js  =  genx-base.js  +  clients/{slug}.js
```

**Estos archivos nunca se publican.** `webpack.pwa.js` excluye `**/config/**` de
la copia a `dist/` y solo emite el `APP_CONFIG` elegido, renombrado. Ningún
cliente recibe el datastore de otro.

## Agregar un cliente

1. Copiar `mx-san-mungo.js` con el slug nuevo.
2. Poner su datastore: `cd infra/hospitals/{slug} && tofu output -raw datastore_id`.
3. Poner su Keycloak: `window.config.oidc[0].authority`, el mismo valor que
   `oidc_issuer` en `infra/viewer/terraform.tfvars`.
4. Publicar: `scripts/publish-client.sh {slug} v3 genx-viewer <distribution-id>`.

No hace falta recompilar el visor: el `dist/` es el mismo para todos.

## Qué va aquí y qué no

**Sí:** datastore, `oidc[0].authority`, título, logo — lo que distingue a un
cliente **o a un entorno**. El issuer está aquí y no en el base justamente para
que un mismo build sirva a QA y a producción apuntando a Keycloak distintos.

**No:** comportamiento del visor (`stackRetrieveOptions`, `httpErrorHandler`,
`maxNumRequests`…). Eso vive en `genx-base.js` y se comparte. Duplicarlo por
cliente es exactamente cómo N configs empiezan a divergir.

## Gates de la publicación

`publish-client.sh` ejecuta el config compuesto antes de subirlo y corta si:

- el delta no asignó `qidoRoot`/`wadoRoot`;
- no asignó `oidc[0].authority` — se publicaría un visor **sin autenticación**,
  porque `getUserManagerForOpenIdConnectClient()` devuelve `undefined` y solo
  deja un `console.error`;
- el `authority` no es `https` o lleva **barra final** — el claim `iss` de
  Keycloak no la lleva, y `oidc-client-ts` compara la cadena tal cual: falla con
  `Invalid issuer in token response`, que no menciona la barra;
- el `acceptHeader` perdió el transfer-syntax de HTJ2K.

Los tres primeros fallan de forma silenciosa o con un mensaje que apunta al
sitio equivocado. Por eso se cortan en el único punto por el que pasa todo lo
que se publica.

Contexto completo: [`GENX-MULTI-TENANT.md`](../../../../GENX-MULTI-TENANT.md).
