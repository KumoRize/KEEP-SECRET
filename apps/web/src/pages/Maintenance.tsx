import { Link } from 'react-router-dom';

export function MaintenancePage({ message }: { message: string }) {
  return (
    <div className="auth">
      <div className="aurora" />
      <div className="card glow stack" style={{ textAlign: 'center', alignItems: 'center' }}>
        <span className="logo" style={{ width: 52, height: 52, fontSize: 24, borderRadius: 15 }}>✦</span>
        <h1>We'll be right <span className="gradient-text">back</span></h1>
        <p className="muted">{message}</p>
        <p className="tiny muted"><Link to="/login">Owner login</Link></p>
      </div>
    </div>
  );
}
