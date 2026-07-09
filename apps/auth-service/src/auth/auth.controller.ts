import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import {
  AuthResponse,
  ChangePasswordInput,
  changePasswordInputSchema,
  LoginInput,
  loginInputSchema,
  RegisterInput,
  registerInputSchema,
  UpdateProfileInput,
  updateProfileInputSchema,
} from '@esfl/contracts';
import type { SafeUser } from './auth.service';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AccessTokenGuard, AuthenticatedRequest } from './access-token.guard';
import { AuthService, toPublicUser } from './auth.service';
import { REFRESH_COOKIE, refreshCookieOptions } from './cookies';
import { TokensService } from './tokens.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService,
  ) {}

  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerInputSchema)) body: RegisterInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const user = await this.authService.register(body);
    return this.openSession(user, res);
  }

  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginInputSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const user = await this.authService.validateLogin(body.email, body.password);
    return this.openSession(user, res);
  }

  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!raw) {
      throw new UnauthorizedException('Aucune session');
    }
    const rotated = await this.tokens.rotateRefreshToken(raw);
    if (!rotated) {
      // Pas de clearCookie ici : un refresh concurrent a pu poser un cookie
      // valide entre-temps, l'effacer détruirait sa session.
      throw new UnauthorizedException('Session expirée');
    }
    res.cookie(
      REFRESH_COOKIE,
      rotated.refresh.token,
      refreshCookieOptions(this.config, this.tokens.refreshTtlMs),
    );
    return {
      accessToken: await this.tokens.signAccessToken(rotated.user),
      user: toPublicUser(rotated.user),
    };
  }

  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (raw) {
      await this.tokens.revokeRefreshToken(raw);
    }
    res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
    return { ok: true };
  }

  @Get('users')
  users(@Query('ids') ids?: string) {
    return this.authService.listPublicUsers(ids ? ids.split(',').filter(Boolean) : []);
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  async me(@Req() req: AuthenticatedRequest) {
    const user = await this.authService.getById(req.user.sub);
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable');
    }
    return toPublicUser(user);
  }

  @Put('me')
  @UseGuards(AccessTokenGuard)
  async updateProfile(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateProfileInputSchema)) body: UpdateProfileInput,
  ) {
    return toPublicUser(await this.authService.updateUsername(req.user.sub, body.username));
  }

  @Put('me/password')
  @UseGuards(AccessTokenGuard)
  async changePassword(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(changePasswordInputSchema)) body: ChangePasswordInput,
  ): Promise<{ ok: true }> {
    await this.authService.changePassword(req.user.sub, body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Post('me/avatar')
  @UseGuards(AccessTokenGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadAvatar(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Aucun fichier reçu (champ « file », image ≤ 2 Mo)');
    }
    await this.authService.setAvatar(req.user.sub, file.buffer, file.mimetype);
    const user = await this.authService.getById(req.user.sub);
    return user ? toPublicUser(user) : { ok: true };
  }

  @Delete('me')
  @UseGuards(AccessTokenGuard)
  async deleteAccount(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.authService.deleteAccount(req.user.sub);
    res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
    return { ok: true };
  }

  /** Avatar public d'un utilisateur (affiché dans classements et membres). */
  @Get('users/:id/avatar')
  async avatar(@Param('id') id: string, @Res() res: Response) {
    const { avatar, mime } = await this.authService.getAvatar(id);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(avatar);
  }

  /** Émet l'access token + pose le cookie de refresh token. */
  private async openSession(user: SafeUser, res: Response): Promise<AuthResponse> {
    const refresh = await this.tokens.issueRefreshToken(user.id);
    res.cookie(
      REFRESH_COOKIE,
      refresh.token,
      refreshCookieOptions(this.config, this.tokens.refreshTtlMs),
    );
    return {
      accessToken: await this.tokens.signAccessToken(user),
      user: toPublicUser(user),
    };
  }
}
