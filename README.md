# @sudobility/shapeshyft_service

Shared tables, routes and middleware for ShapeShyft-style structured-output APIs.

```ts
const service = createShapeshyftService({
  db,
  tables,
  keyPrefixes: { user: "shyft_", entity: "shyftent" },
  encryption,
  auth,
  email,
  credentials, // ProviderCredentialResolver: where provider API keys come from
});

app.route("/api/v1", service.buildRoutes({ mountAdmin }));
```
