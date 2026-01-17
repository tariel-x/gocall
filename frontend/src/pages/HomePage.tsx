import { Link } from 'react-router-dom';

const HomePage = () => {
  return (
    <main className="page">
      <h1>Gocall</h1>
      <p>Это заглушка для будущего интерфейса.</p>
      <p>
        <Link to="/wait" className="page-link">
          Перейти на страницу ожидания
        </Link>
      </p>
    </main>
  );
};

export default HomePage;
