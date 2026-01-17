import { Navigate, Route, Routes } from 'react-router-dom';
import StartPage from './pages/StartPage';
import WaitPage from './pages/WaitPage';
import JoinPage from './pages/JoinPage';
import CallPage from './pages/CallPage';

const App = () => {
  return (
    <Routes>
      <Route path="/" element={<StartPage />} />
      <Route path="/wait/:callId" element={<WaitPage />} />
      <Route path="/join/:callId" element={<JoinPage />} />
      <Route path="/call/:callId" element={<CallPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default App;
