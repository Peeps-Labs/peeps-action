class LoginPage {
  get username() {
    return $("~username");
  }

  get password() {
    return $("~password");
  }

  async login(user: string, secret: string): Promise<void> {
    await this.username.setValue(user);
    await this.password.setValue(secret);
    await $("~sign-in").click();
  }
}

export default new LoginPage();
