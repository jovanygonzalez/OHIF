// Delta de cliente: San Mungo (slug `mx-san-mungo`).
//
// Se concatena DESPUÉS de genx-base.js para formar el app-config.js que se
// publica en el sitio de este cliente. Solo va aquí lo que difiere del base.
//
// El datastore debe coincidir con el del stack del hospital:
//   cd infra/hospitals/mx-san-mungo && tofu output -raw datastore_id

Object.assign(window.config.dataSources[0].configuration.healthlake, {
  datastoreID: '233cd98bfad7421ab3ac51e9235cc5b1',
});

// El título va horneado en index.html en tiempo de build, así que para que sea
// por cliente hay que pisarlo aquí (esto corre antes de que monte React).
document.title = 'San Mungo — Visor';
