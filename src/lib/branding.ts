// Product identity, kept apart from tenant identity.
//
// APP_NAME is the vendor's product — it is the same for every customer, so it is the
// only name that is safe to render before we know which organization is signed in
// (the login screen, the static <title> in index.html, the first paint of the shell).
// Everything a signed-in user sees inside the app carries the tenant's own name,
// which comes from `organizations.name` via AuthContext.
export const APP_NAME = 'SupplyFlow';
