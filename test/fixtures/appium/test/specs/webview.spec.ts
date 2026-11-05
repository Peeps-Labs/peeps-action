describe("Checkout web view", () => {
  before(async () => {
    await browser.switchContext("WEBVIEW_com.example.shop");
  });

  it("pays with a card", async () => {
    await $("#card-number").setValue("4242 4242 4242 4242");
    await $("button[type=submit]").click();
  });

  for (const currency of ["EUR"]) {
    it(`shows totals in ${currency}`, async () => {
      await expect($(".total")).toHaveText(new RegExp(currency));
    });
  }
});
