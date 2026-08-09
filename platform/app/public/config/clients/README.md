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
3. Publicar: `scripts/publish-client.sh {slug} v3 genx-viewer <distribution-id>`.

No hace falta recompilar el visor: el `dist/` es el mismo para todos.

## Qué va aquí y qué no

**Sí:** datastore, título, logo — lo que distingue a un cliente.

**No:** comportamiento del visor (`stackRetrieveOptions`, `httpErrorHandler`,
`maxNumRequests`…). Eso vive en `genx-base.js` y se comparte. Duplicarlo por
cliente es exactamente cómo N configs empiezan a divergir.

Contexto completo: [`GENX-MULTI-TENANT.md`](../../../../GENX-MULTI-TENANT.md).
