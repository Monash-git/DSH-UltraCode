/**
 * Add the selector-level Ultra tier to DeepSeek models without patching DSH.
 *
 * The tier is persisted as `ultra` in the session selection, while every
 * provider request is mapped back to `max`, the highest wire effort DeepSeek
 * supports. Only models that already advertise `max` are decorated.
 */
const ULTRA = 'ultra';
const MAX = 'max';
const DEEPSEEK_PROVIDERS = new Set(['deepseek-official', 'deepseek-account']);
const ULTRA_EFFORT = {
    id: ULTRA,
    name: 'Ultra',
    description: 'Plan, orchestrate, and verify with Ultracode.',
};
/** Install the decoration once the optional LLM service is active. */
export function registerUltraEffort(ctx) {
    ctx.inject(['llm'], scoped => {
        const restore = installUltraEffort(scoped);
        scoped.effect(() => restore);
    });
}
/** Install the Ultra effort decoration; returns a disposer that restores the service. */
export function installUltraEffort(ctx) {
    const llm = ctx.get('llm');
    if (llm === undefined)
        return () => { };
    const original = {
        resolveModelInfo: llm.resolveModelInfo.bind(llm),
        resolveCallConfig: llm.resolveCallConfig.bind(llm),
        prepareCall: llm.prepareCall.bind(llm),
        stream: llm.stream.bind(llm),
    };
    llm.resolveModelInfo = async (provider, model, signal) => {
        const info = await original.resolveModelInfo(provider, model, signal);
        if (!DEEPSEEK_PROVIDERS.has(provider))
            return info;
        const reasoning = info.reasoning;
        if (reasoning === undefined)
            return info;
        if (!reasoning.efforts.some(effort => effort.id === MAX))
            return info;
        if (reasoning.efforts.some(effort => effort.id === ULTRA))
            return info;
        return {
            ...info,
            reasoning: {
                ...reasoning,
                efforts: [...reasoning.efforts, ULTRA_EFFORT],
            },
        };
    };
    llm.resolveCallConfig = async (config, signal) => {
        if (config.reasoningEffort !== ULTRA)
            return original.resolveCallConfig(config, signal);
        const resolved = await original.resolveCallConfig(withMax(config), signal);
        return { ...resolved, reasoningEffort: ULTRA };
    };
    llm.prepareCall = async (config, signal, configure) => {
        const prepared = await original.prepareCall(withMax(config), signal, configure);
        return {
            ...prepared,
            stream: (options) => prepared.stream(withMax(options)),
        };
    };
    llm.stream = options => original.stream(withMax(options));
    return () => {
        llm.resolveModelInfo = original.resolveModelInfo;
        llm.resolveCallConfig = original.resolveCallConfig;
        llm.prepareCall = original.prepareCall;
        llm.stream = original.stream;
    };
}
function withMax(config) {
    if (config.reasoningEffort !== ULTRA)
        return config;
    return { ...config, reasoningEffort: MAX };
}
//# sourceMappingURL=effort.js.map