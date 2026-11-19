export const UNSUPPORTED = Object.freeze({ unsupported: true });

export const RUNTIME_CONTRACT = Object.freeze({
  identity: Object.freeze({ required: true, members: Object.freeze({ findExecutable: 'required' }) }),
  install: Object.freeze({ required: true, members: Object.freeze({
    probeVersion: 'required',
    install: 'optional',
    installNotice: 'optional',
    upgradeCli: 'optional',
    latestVersion: 'optional',
    installsToLocalBin: 'optional',
    dailyUpgradePrompt: 'optional',
    uninstall: 'optional',
    postUpgradeSync: 'optional',
  }) }),
  auth: Object.freeze({ required: true, members: Object.freeze({
    checkAuth: 'required',
    remedy: 'required',
    credentialFiles: 'required',
    credentialKinds: 'optional',
    saveCredential: 'optional',
    saveBaseUrl: 'optional',
    baseUrlExample: 'optional',
    nativeLogin: 'optional',
    afterLogin: 'optional',
    overrideWarnings: 'optional',
  }) }),
  launch: Object.freeze({ required: true, members: Object.freeze({ prepare: 'required', checkAutonomous: 'optional' }) }),
  input: Object.freeze({ required: true, members: Object.freeze({ bracketedPaste: 'required' }) }),
});
