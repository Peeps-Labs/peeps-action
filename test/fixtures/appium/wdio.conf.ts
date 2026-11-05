// A WebdriverIO v9 + Appium config, as `npm init wdio` writes one for an
// Android emulator. Collection never starts the session it describes.
export const config = {
  runner: "local",
  port: 4723,
  specs: ["./test/specs/**/*.spec.ts"],
  exclude: ["./test/specs/**/*.draft.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "emulator-5554",
      "appium:app": "./apps/sample.apk",
    },
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },
};
