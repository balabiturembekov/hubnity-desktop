import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { useAuthStore } from '../store/useAuthStore';

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
      setError('Введите email');
      return;
    }
    
    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      setError('Введите корректный email адрес');
      return;
    }
    
    // Password validation
    if (!password || password.length < 1) {
      setError('Введите пароль');
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
      let errorMessage = 'Ошибка входа';
      
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
    <div className="flex items-center justify-center h-screen p-6 bg-background">
      <Card className="w-full max-w-md border shadow-sm">
        <CardHeader className="pb-6 pt-8">
          <CardTitle className="text-2xl text-center font-semibold tracking-tight">
            Вход в систему
          </CardTitle>
          <CardDescription className="text-center text-muted-foreground/80 mt-2">
            Введите ваши учетные данные
          </CardDescription>
        </CardHeader>
        <CardContent className="px-8 pb-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  // FIX: Очищаем ошибку при изменении email
                  if (error) setError(null);
                }}
                required
                disabled={isLoading}
                className="h-10 transition-colors duration-300"
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium">
                Пароль
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  // FIX: Очищаем ошибку при изменении пароля
                  if (error) setError(null);
                }}
                required
                disabled={isLoading}
                className="h-10 transition-colors duration-300"
                autoComplete="current-password"
              />
            </div>
            {error && (
              <div className="text-sm text-destructive/90 p-3 rounded-md bg-destructive/5 animate-in fade-in transition-colors duration-300">
                {error}
              </div>
            )}
            <Button 
              type="submit" 
              className="w-full h-10 mt-2 transition-colors duration-300" 
              disabled={isLoading}
            >
              {isLoading ? 'Вход...' : 'Войти'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

