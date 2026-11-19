import { readFile } from 'node:fs/promises'

const document = JSON.parse(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'))
const operations = Object.entries(document.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ path, method, operation })))
const failures = []
for (const { path, method, operation } of operations) {
  const success = operation.responses?.['200']
  if (!operation['x-response-contract-status']) failures.push(`${method.toUpperCase()} ${path}: missing response contract status`)
  if (!Object.values(success?.content ?? {}).some(content => content.schema) && !operation.responses?.['204']) failures.push(`${method.toUpperCase()} ${path}: missing success response schema`)
  if (JSON.stringify(success?.content ?? {}).includes('#/components/schemas/JSONValue')) failures.push(`${method.toUpperCase()} ${path}: generic JSONValue success response`)
  if (operation['x-contract-status'] === 'placeholder-request-schema') failures.push(`${method.toUpperCase()} ${path}: placeholder request body`)
  if (operation['x-response-contract-status'] === 'documented-paginated-entity-response') {
    const parameters = new Set(operation.parameters?.filter(parameter => parameter.in === 'query').map(parameter => parameter.name))
    for (const name of ['page', 'pageSize', 'sortBy', 'sortOrder', 'search']) if (!parameters.has(name)) failures.push(`${method.toUpperCase()} ${path}: pagination is missing ${name}`)
  }
}
if (failures.length) throw new Error(`OpenAPI contract check failed:\n${failures.join('\n')}`)
console.log(`OpenAPI contracts verified: ${Object.keys(document.paths).length} paths, ${operations.length} operations, ${operations.filter(({ operation }) => operation['x-response-contract-status'] === 'documented-paginated-entity-response').length} paginated list responses.`)
