import LoginPage from "../pageobjects/login.page";

// Read while the suite is being defined: collection runs no session, so this
// must not throw there.
const platform: string = String(browser.capabilities.platformName ?? "");

describe("Login", () => {
  it("signs in with a valid account @smoke", async () => {
    await LoginPage.login("alice", "secret");
    await expect($("~home")).toBeDisplayed();
  });

  it("shows an error for a wrong password (and [brackets])", async () => {
    await LoginPage.login("alice", "wrong");
    await expect($("~error")).toHaveText(`Wrong password on ${platform}`);
  });

  describe("Forgot password", () => {
    it.skip("sends a reset link", async () => {
      await $("~forgot").click();
    });
  });
});

it("opens without a describe", async () => {
  await expect($("~welcome")).toBeDisplayed();
});
