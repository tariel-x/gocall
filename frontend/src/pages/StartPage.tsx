import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createCall } from '../services/api';
import { resetSession, setCallContext } from '../services/session';

const StartPage = () => {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    resetSession();
  }, []);

  const handleStartCall = async () => {
    if (isLoading) {
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      resetSession();
      const call = await createCall();
      setCallContext(call.call_id);
      navigate(`/wait/${call.call_id}`);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Не удалось создать звонок. Попробуйте ещё раз.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="page">
      <h1>Gocall</h1>
      <p>Создайте звонок и поделитесь ссылкой с собеседником.</p>
      <button className="primary-button" onClick={handleStartCall} disabled={isLoading}>
        {isLoading ? 'Создаём…' : 'Начать звонок'}
      </button>
      {error && <p className="page-error">{error}</p>}
    </main>
  );
};

export default StartPage;
