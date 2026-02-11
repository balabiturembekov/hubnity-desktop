import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { AlertCircle, Mail, Lock, ArrowRight, Clock } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';

const REGISTRATION_URL = 'https://hubnity.automatonsoft.de';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = useAuthStore((state) => state.login);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Prevent multiple simultaneous submissions
    if (isLoading) {
      return;
    }
    
    // FIX: Проверяем пустоту email отдельно для более понятного сообщения
    if (!email || !email.trim()) {
      setError('Enter email');
      return;
    }
    
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      setError('Enter a valid email address');
      return;
    }
    
    // Password validation
    if (!password || password.length < 1) {
      setError('Enter password');
      return;
    }
    
    setError(null);
    setIsLoading(true);

    try {
      // FIX: Обрезаем пробелы в пароле для предотвращения ошибок из-за случайных пробелов
      await login({ email: email.trim(), password: password.trim() });
      // FIX: Очищаем оба поля после успешного входа (security best practice)
      setPassword('');
      setEmail('');
    } catch (err: any) {
      // Extract error message from various error formats
      let errorMessage = 'Login error';
      
      if (err?.response?.data?.message) {
        errorMessage = err.response.data.message;
      } else if (err?.response?.data?.error) {
        errorMessage = err.response.data.error;
      } else if (typeof err?.response?.data === 'string') {
        errorMessage = err.response.data;
      } else if (err?.message) {
        errorMessage = err.message;
      }
      
      // Sanitize error message to prevent XSS (basic protection)
      errorMessage = errorMessage.replace(/<[^>]*>/g, '');
      
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-background">
      {/* Branding above the card */}
      <div className="flex flex-col items-center mb-8">
        <div className="w-14 h-14 rounded-full bg-primary flex items-center justify-center mb-3">
          <Clock className="h-7 w-7 text-primary-foreground" />
        </div>
        <h1 className="text-xl font-bold text-foreground tracking-tight">Hubnity</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Time Tracking & Team Management</p>
      </div>

      <Card className="w-full max-w-md border shadow-sm">
        <CardHeader className="pb-4 pt-6">
          <CardTitle className="text-2xl font-semibold tracking-tight">
            → Welcome back,
          </CardTitle>
          <CardDescription className="text-muted-foreground/80 mt-2">
            Enter your credentials to access your account
          </CardDescription>
        </CardHeader>
        <CardContent className="px-8 pb-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium">
                Email address
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError(null);
                  }}
                  required
                  disabled={isLoading}
                  className="h-10 pl-10 transition-colors duration-300"
                  autoComplete="email"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium">
                Password
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  required
                  disabled={isLoading}
                  className="h-10 pl-10 transition-colors duration-300"
                  autoComplete="current-password"
                />
              </div>
            </div>
            {error && (
              <div className="flex gap-2.5 p-3 rounded-lg bg-muted/50 border border-border animate-in fade-in">
                <AlertCircle className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                <span className="text-sm text-muted-foreground">{error}</span>
              </div>
            )}
            <Button
              type="submit"
              className="w-full h-10 mt-2 gap-2 transition-colors duration-300"
              disabled={isLoading}
            >
              {isLoading ? 'Loading...' : (
                <>
                  Log in
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </form>
          <p className="text-center text-sm text-muted-foreground mt-6">
            Don&apos;t have an account?{' '}
            <a
              href={REGISTRATION_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground font-medium hover:underline"
            >
              Create one
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

