module.exports = {
  hooks: {
    prePackage: async (_config, platform, arch) => {
      if (platform === 'win32')
        require('./spike/windows-package-check.cjs').checkWindowsPackage(__dirname, arch);
    },
  },
  packagerConfig: {
    name: 'XXFinanceStage0',
    executableName: 'xx-finance-stage0',
    asar: true,
    ignore: [
      /^\/out(?:\/|$)/,
      /^\/\.github(?:\/|$)/,
      /^\/\.git(?:\/|$)/,
      /^\/\.env(?:\.|$)/,
      /^\/\.local-data/,
      /^\/evidence/,
      /^\/docs/,
      /^\/tests/,
      /^\/prototype/,
      /^\/spike\/windows-launcher\.cpp$/,
      /^\/\.impeccable/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'xx_finance_stage0',
        authors: 'XXFinance',
        description: 'Stage 0 dependency probe; not a production ledger',
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  ],
  plugins: [{ name: '@electron-forge/plugin-auto-unpack-natives', config: {} }],
};
