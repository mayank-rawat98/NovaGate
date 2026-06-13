import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(200)
  async register(
    @Body() body: { name: string; email: string; password: string },
  ) {
    await this.authService.register(body.name, body.email, body.password);
    // Generic response — never reveals whether the email was already registered.
    return {
      message:
        'If that email is available, a verification link has been sent. Check your inbox to finish signing up.',
    };
  }

  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Body() body: { token: string }) {
    return this.authService.verifyEmail(body.token);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: { email: string; password: string }) {
    return this.authService.login(body.email, body.password);
  }

  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() body: { email: string }) {
    await this.authService.forgotPassword(body.email);
    return {
      message: 'If that email is registered, a reset link has been sent.',
    };
  }

  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() body: { token: string; password: string }) {
    await this.authService.resetPassword(body.token, body.password);
    return { message: 'Password updated successfully.' };
  }
}
