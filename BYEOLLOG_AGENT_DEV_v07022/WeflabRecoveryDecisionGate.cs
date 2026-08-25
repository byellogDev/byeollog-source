namespace HurogiCollector;

internal enum WeflabHealthSignal
{
    LoginCandidate,
    ApiSuccess,
    ApiFailure
}

internal sealed class WeflabRecoveryDecisionGate
{
    private int _consecutiveFailures;

    internal int ConsecutiveFailures => _consecutiveFailures;

    internal bool Observe(WeflabHealthSignal signal)
    {
        if (signal == WeflabHealthSignal.ApiSuccess)
        {
            _consecutiveFailures = 0;
            return false;
        }

        if (signal == WeflabHealthSignal.LoginCandidate)
            return false;

        _consecutiveFailures++;
        if (_consecutiveFailures < 2) return false;
        _consecutiveFailures = 0;
        return true;
    }
}
