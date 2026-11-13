import { StudioError } from './kernel.js'

const string = { type: 'string' }
const types = { type: 'string', enum: ['script', 'shot', 'prompt', 'image', 'video', 'audio', 'note'] }
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

const query = {
  id: string, q: string, type: types, episodeId: string, sceneId: string, shotId: string,
  createdBySession: string, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
}
const node = object({
  id: string, type: types, basedOn: string, episodeId: string, sceneId: string, shotId: string,
  content: {
    type: 'object', additionalProperties: true,
    description: 'Creative content to append. A video draft must contain its full prompt and receive only actual image, video or audio input edges.',
  },
}, ['type', 'content'])
const edge = object({ source: string, target: string }, ['source', 'target'])
const append = {
  operationId: { type: 'string', description: 'New unique operation ID. Reuse it when retrying the same operation.' },
  nodes: { type: 'array', items: node },
  edges: { type: 'array', items: edge },
}

export function registerTools(ctx, workspaceFor, kernel, keys, protectNodes) {
  for (const [action, description, parameters] of [
    ['context', 'Read the current native Session, its Workspace Canvas binding and generation permission.', object({})],
    ['query', 'Read shared creative nodes and references for this Session’s Canvas. Filter by shot, type or source Session.', object(query)],
    ['append', 'Append creative nodes and references atomically. To revise a node as an Agent, append a new node with basedOn. Video prompts must be complete and inline, with only real media inputs.', object(append, ['operationId'])],
    ['submit', 'Submit a snapshot of an image or video draft by node ID. The current Session must already have automatic generation permission. Omit profileId to use the draft preset or the configured mode default.', object({ operationId: string, nodeId: string, profileId: string }, ['operationId', 'nodeId'])],
    ['tasks', 'Read generation task states for this Session’s shared Canvas.', object({})],
  ]) {
    ctx.tools.register({
      name: `drama_${action}`,
      description,
      parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const data = keys(args, ...Object.keys(parameters.properties))
        const sessionId = exec.agent?.session.id
        if (!sessionId) throw new StudioError(403, 'A native DSH Agent Session is required')
        const workspace = await workspaceFor(ctx, sessionId)
        if (action === 'query' || action === 'submit') protectNodes(exec.agent, [data.id, data.nodeId])
        if (action === 'append') protectNodes(exec.agent, [
          ...(data.nodes ?? []).flatMap(item => [item.id, item.basedOn]),
          ...(data.edges ?? []).flatMap(item => [item.source, item.target]),
        ])
        const result = await kernel(sessionId, workspace, action, data, exec.signal)
        if (action === 'query') protectNodes(exec.agent, [
          ...result.nodes.flatMap(item => [item.id, item.basedOn]),
          ...(result.referenceNodes ?? []).map(item => item.id),
          ...result.edges.flatMap(item => [item.source, item.target]),
          ...Object.values(result.resolvedMedia ?? {}).map(item => item.id),
        ])
        if (action === 'append') protectNodes(exec.agent, result.ids ?? [])
        return action === 'context' ? { ...result, workspacePath: workspace.path } : result
      },
    })
  }
}
