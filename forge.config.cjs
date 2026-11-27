module.exports = {
  hooks: {
    prePackage: async (_config, platform, arch) => {
      if (platform === 'win32')
        require('./scripts/windows/package-check.cjs').checkWindowsPackage(__dirname, arch);
    },
  },
  packagerConfig: {
    name: 'Qianlai',
    executableName: 'qianlai-app',
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
      /^\/scripts(?:\/|$)/,
      /^\/src\/renderer(?:\/|$)/,
      /^\/\.impeccable/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'qianlai',
        authors: 'Qianlai',
        description: '钱来：单人离线报销台账',
      },
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  ],
  plugins: [{ name: '@electron-forge/plugin-auto-unpack-natives', config: {} }],
};
