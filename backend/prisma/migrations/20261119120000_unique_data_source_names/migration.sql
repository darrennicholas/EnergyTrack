-- Resolve duplicate names manually before applying; existing sources and their history are retained.
CREATE UNIQUE INDEX "IntegrationSource_org_normalized_name_key"
  ON "IntegrationSource" ("organizationId", lower(btrim("name")));
