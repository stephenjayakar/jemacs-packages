import type {
  DapAdapterDescriptor,
  DapCommandVariableResolver,
  DapConfigurationProvider,
  DapTaskProvider,
} from "./types"

const adapters = new Map<string, DapAdapterDescriptor>()
const configurationProviders = new Set<DapConfigurationProvider>()
const commandVariables = new Map<string, DapCommandVariableResolver>()
let taskProvider: DapTaskProvider | null = null

export function registerDapAdapter(descriptor: DapAdapterDescriptor): () => void {
  for (const type of descriptor.types) adapters.set(type, descriptor)
  return () => {
    for (const type of descriptor.types) if (adapters.get(type) === descriptor) adapters.delete(type)
  }
}

export function dapAdapter(type: string): DapAdapterDescriptor | undefined {
  return adapters.get(type)
}

export function registerDapConfigurationProvider(provider: DapConfigurationProvider): () => void {
  configurationProviders.add(provider)
  return () => configurationProviders.delete(provider)
}

export function listDapConfigurationProviders(): DapConfigurationProvider[] {
  return [...configurationProviders]
}

export function registerDapCommandVariable(name: string, resolver: DapCommandVariableResolver): () => void {
  commandVariables.set(name, resolver)
  return () => { if (commandVariables.get(name) === resolver) commandVariables.delete(name) }
}

export function dapCommandVariable(name: string): DapCommandVariableResolver | undefined {
  return commandVariables.get(name)
}

export function registerDapTaskProvider(provider: DapTaskProvider): () => void {
  const previous = taskProvider
  taskProvider = provider
  return () => { if (taskProvider === provider) taskProvider = previous }
}

export function dapTaskProvider(): DapTaskProvider | null {
  return taskProvider
}
