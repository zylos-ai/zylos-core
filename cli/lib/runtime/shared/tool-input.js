const INPUT_FIELDS = { Bash:['command','description'], Read:['file_path'], Edit:['file_path'], Write:['file_path'], Skill:['skill'], Agent:['description','subagent_type'], Task:['description','subagent_type'], WebSearch:['query'], WebFetch:['url'], view_image:['path'] };
export function selectToolInput(tool, input) {
  if (tool === 'run_command' && input && typeof input === 'object') {
    return Object.fromEntries(['CommandLine', 'Cwd'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  }
  if (tool === 'apply_patch') {
    const patch = typeof input === 'string' ? input : input?.patch ?? input?.input;
    return typeof patch === 'string' ? { file_paths: [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match=>match[1]) } : undefined;
  }
  if (!input || typeof input !== 'object' || !INPUT_FIELDS[tool]) return undefined;
  return Object.fromEntries(INPUT_FIELDS[tool].filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));
}
